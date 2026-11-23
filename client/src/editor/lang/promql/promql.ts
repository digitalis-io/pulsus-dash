/**
 * PromQL as a `QueryLanguage` (T09 §5.1, ADR-0018; plan #63 Part B §3.1): the shape analyser on
 * the Lezer tree of `@prometheus-io/lezer-promql`, the mapping of PulsusDB's `queryInvalid` byte
 * offset to an underline (T09-009), and the editor extensions (`extensions.ts`). Nothing here
 * decides whether a query is valid: PulsusDB does (T09-002, ADR-0015).
 */
import type { SyntaxNode } from '@lezer/common';
import { parser } from '@prometheus-io/lezer-promql';
import { positionDiagnostics } from '../diagnostics';
import { UNKNOWN_SHAPE, type QueryLanguage, type QueryShape, type ValueType } from '../types';
import { promqlExtensions } from './extensions';
import { createPromSource } from './promSource';

// Moved to `lang/diagnostics.ts` (plan #66 Part A §3.8): LogQL maps run errors the same way.
export { utf8ToIndex, positionDiagnostics as diagnosticsOf } from '../diagnostics';

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

export const promql: QueryLanguage = {
  lang: 'promql',
  editor: (deps) => promqlExtensions(createPromSource(deps)),
  shape: analysePromQL,
  diagnosticsOf: positionDiagnostics,
  // ⌘K detection (INT-038) is not built yet: PromQL claims no prefix.
  detect: () => 0,
};
