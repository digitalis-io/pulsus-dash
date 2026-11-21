/**
 * PromQL as a `QueryLanguage` (T09 §5.1, ADR-0018; plan #63 Part B §3.1): the shape analyser on
 * the Lezer tree of `@prometheus-io/lezer-promql`, the mapping of PulsusDB's `queryInvalid` byte
 * offset to an underline (T09-009), and the editor extensions (`extensions.ts`). Nothing here
 * decides whether a query is valid: PulsusDB does (T09-002, ADR-0015).
 */
import type { SyntaxNode } from '@lezer/common';
import { parser } from '@prometheus-io/lezer-promql';
import { isApiError } from '../../../api/types';
import { t } from '../../../i18n/t';
import {
  UNKNOWN_SHAPE,
  type Diagnostic,
  type QueryLanguage,
  type QueryShape,
  type ValueType,
} from '../types';
import { promqlExtensions } from './extensions';
import { createPromSource } from './promSource';

const UNWRAP = new Set([
  'ParenExpr',
  'UnaryExpr',
  'OffsetExpr',
  'StepInvariantExpr',
  'AnchoredExpr',
  'SmoothedExpr',
]);
const SCALAR_FUNCTIONS = new Set(['Scalar', 'Time', 'Pi']);
const QUANTILE_FUNCTIONS = new Set(['HistogramQuantile', 'HistogramQuantiles']);

const exprs = (n: SyntaxNode): SyntaxNode[] => n.getChildren('Expr');

function valueType(n: SyntaxNode | undefined): ValueType {
  if (n === undefined) return 'vector';
  if (UNWRAP.has(n.name)) return valueType(exprs(n)[0]);
  switch (n.name) {
    case 'NumberDurationLiteral':
      return 'scalar';
    case 'StringLiteral':
      return 'string';
    case 'BinaryExpr':
      return exprs(n).every((e) => valueType(e) === 'scalar') ? 'scalar' : 'vector';
    case 'FunctionCall': {
      const fn = n.getChild('FunctionIdentifier')?.firstChild?.name;
      return fn !== undefined && SCALAR_FUNCTIONS.has(fn) ? 'scalar' : 'vector';
    }
    case 'MatrixSelector':
    case 'SubqueryExpr':
      return 'matrix';
    default:
      return 'vector';
  }
}

/** What the planner needs to know about `text` (B.4.1); `UNKNOWN_SHAPE` when it does not parse. */
export function analysePromQL(text: string): QueryShape {
  const tree = parser.parse(text);
  const metrics: string[] = [];
  let quantile = false;
  const c = tree.cursor();
  do {
    if (c.type.isError) return UNKNOWN_SHAPE;
    if (c.name === 'VectorSelector') {
      const id = c.node.getChild('Identifier');
      if (id !== null) {
        const m = text.slice(id.from, id.to);
        if (!metrics.includes(m)) metrics.push(m);
      }
    }
    if (c.name === 'FunctionIdentifier') {
      const fn = c.node.firstChild?.name;
      if (fn !== undefined && QUANTILE_FUNCTIONS.has(fn)) quantile = true;
    }
  } while (c.next());
  const top = tree.topNode.getChildren('Expr')[0];
  if (top === undefined) return UNKNOWN_SHAPE;
  const id = top.name === 'VectorSelector' ? top.getChild('Identifier') : null;
  return {
    bareSelector:
      id === null ? null : { metric: text.slice(id.from, id.to), from: top.from, to: top.to },
    metrics,
    hasHistogramQuantile: quantile,
    valueType: valueType(top),
  };
}

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

function utf8Width(cp: number): number {
  if (cp < 0x80) return 1;
  if (cp < 0x800) return 2;
  if (cp < 0x10000) return 3; // lone surrogates too, as Part A's utf8Length
  return 4;
}

/**
 * UTF-16 index of the code point holding UTF-8 byte `byte` of `s`; `s.length` when `byte` is the
 * byte length; null when `byte` is not an integer, negative or past the end.
 */
export function utf8ToIndex(s: string, byte: number): number | null {
  if (!Number.isInteger(byte) || byte < 0) return null;
  let b = 0;
  let i = 0;
  while (i < s.length) {
    const cp = s.codePointAt(i) ?? 0;
    const n = utf8Width(cp);
    if (byte < b + n) return i;
    b += n;
    i += cp > 0xffff ? 2 : 1;
  }
  return byte === b ? s.length : null;
}

/** The start index of the last code point of a non-empty `s`. */
function lastCodePoint(s: string): number {
  const k = s.length - 1;
  return k > 0 && isLow(s.charCodeAt(k)) && isHigh(s.charCodeAt(k - 1)) ? k - 1 : k;
}

/**
 * The underline of a failed run (T09-009): PulsusDB's byte offset into `sent`, mapped to `text`
 * through `toSource`; the whole text, marked "position unknown", when there is no position, it is
 * out of range or inside text the planner added. Only `queryInvalid` errors place anything.
 */
export function diagnosticsOf(
  text: string,
  error: unknown,
  toSource: (sentIndex: number) => number | null,
  sent: string,
): Diagnostic[] {
  if (!isApiError(error, 'queryInvalid') || text === '') return [];
  const p = error.detail.position;
  const i = typeof p === 'number' ? utf8ToIndex(sent, p) : null;
  const j = i === null ? null : toSource(i);
  if (j !== null && j >= 0) {
    const from = j < text.length ? j : lastCodePoint(text);
    const pair = isHigh(text.charCodeAt(from)) && isLow(text.charCodeAt(from + 1));
    return [{ from, to: from + (pair ? 2 : 1), message: error.message, positionKnown: true }];
  }
  return [
    {
      from: 0,
      to: text.length,
      message: error.message + t('explore.error.positionUnknown'),
      positionKnown: false,
    },
  ];
}

export const promql: QueryLanguage = {
  lang: 'promql',
  editor: (deps) => promqlExtensions(createPromSource(deps)),
  shape: analysePromQL,
  diagnosticsOf,
  // ⌘K detection (INT-038) is not built yet: PromQL claims no prefix.
  detect: () => 0,
};
