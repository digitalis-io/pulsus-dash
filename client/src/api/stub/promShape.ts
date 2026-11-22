/**
 * The StubApi planner mirror's shape (plan #112 §3.7, §4.3, A.9): the Lezer shape of the query
 * when the stub type check passes, else the unknown shape, in UTF-8 byte offsets. Lezer parses
 * syntax only, while the server's upstream parser also type-checks and refuses experimental
 * syntax; `typeCheck` mirrors those rules on the Lezer tree, so the stub gives the server's shape.
 * Loaded lazily by `StubApi`, so Lezer stays out of the initial chunk.
 *
 * Known limitations (stub mode only, never the http path; A.9): regular-expression dialects (the
 * server compiles RE2; here the empty string is tested with JavaScript's engine and no pattern is
 * refused), string-escape and number or duration lexing differences, and a Lezer grammar that lags
 * or leads the server's parser release.
 */
import type { SyntaxNode, Tree } from '@lezer/common';
import { parser } from '@prometheus-io/lezer-promql';
import { analysePromQL } from '../../editor/lang/promql/promql';
import type { ValueType } from '../../editor/lang/types';
import { byteShape, type ByteShape } from './plan';
import { STABLE_FUNCTIONS } from './promFunctions';

const UNKNOWN: ByteShape = Object.freeze({
  bare: null,
  metrics: Object.freeze([]),
  hasHistogramQuantile: false,
  valueType: 'unknown',
});

/** A failed type check: the server's parser refuses the text, so its shape is unknown. */
const FAIL = null;
type T = ValueType | typeof FAIL;

const exprs = (n: SyntaxNode): SyntaxNode[] => n.getChildren('Expr');
const COMPARISONS = new Set(['Eql', 'Neq', 'Gtr', 'Lss', 'Gte', 'Lte']);
const SET_OPS = new Set(['And', 'Or', 'Unless']);
const PARAM_SCALAR = new Set(['topk', 'bottomk', 'quantile']);
const EXPERIMENTAL_AGGREGATES = new Set(['limitk', 'limit_ratio']);

/** The value of a string literal (double, single or backtick quoted). @internal exported for its table test. */
export function unquote(lit: string): string {
  const q = lit[0];
  const body = lit.slice(1, -1);
  if (q === '`') return body;
  try {
    const json = q === "'" ? `"${body.replace(/\\'/g, "'").replace(/"/g, '\\"')}"` : lit;
    return JSON.parse(json) as string;
  } catch {
    return body;
  }
}

/** Whether a label matcher accepts the empty string. */
function matchesEmpty(op: string, value: string): boolean {
  switch (op) {
    case '=':
      return value === '';
    case '!=':
      return value !== '';
    case '=~':
    case '!~': {
      let empty: boolean;
      try {
        empty = new RegExp(`^(?:${value})$`, 'su').test('');
      } catch {
        // Never refuse a pattern here: only the server's RE2 decides it (a known limitation).
        return false;
      }
      return op === '=~' ? empty : !empty;
    }
  }
  return false;
}

interface Matcher {
  readonly label: string;
  readonly op: string;
  readonly value: string;
}

function matchersOf(sel: SyntaxNode, text: string): Matcher[] {
  const out: Matcher[] = [];
  const list = sel.getChild('LabelMatchers');
  if (list === null) return out;
  const slice = (n: SyntaxNode | null) => (n === null ? '' : text.slice(n.from, n.to));
  for (let m = list.firstChild; m !== null; m = m.nextSibling) {
    const value = (n: SyntaxNode) => unquote(slice(n.getChild('StringLiteral')));
    if (m.name === 'UnquotedLabelMatcher') {
      out.push({
        label: slice(m.getChild('LabelName')),
        op: slice(m.getChild('MatchOp')),
        value: value(m),
      });
    } else if (m.name === 'QuotedLabelMatcher') {
      const name = m.getChild('QuotedLabelName');
      out.push({
        label: name === null ? '' : unquote(slice(name.getChild('StringLiteral'))),
        op: slice(m.getChild('MatchOp')),
        value: value(m),
      });
    } else if (m.name === 'QuotedLabelName') {
      // `{"name"}`: the metric name in quoted form.
      out.push({ label: '__name__', op: '=', value: unquote(slice(m.getChild('StringLiteral'))) });
    }
  }
  return out;
}

function vectorSelector(n: SyntaxNode, text: string): T {
  const named = n.getChild('Identifier') !== null;
  const ms = matchersOf(n, text);
  if (named) return ms.some((m) => m.label === '__name__') ? FAIL : 'vector';
  return ms.some((m) => !matchesEmpty(m.op, m.value)) ? 'vector' : FAIL;
}

/** The selector under offset and `@` modifiers. */
function modifierBase(n: SyntaxNode): SyntaxNode | undefined {
  let b: SyntaxNode | undefined = exprs(n)[0];
  while (b !== undefined && (b.name === 'OffsetExpr' || b.name === 'StepInvariantExpr'))
    b = exprs(b)[0];
  return b;
}

function binary(n: SyntaxNode, text: string): T {
  const [l, r] = exprs(n);
  if (l === undefined || r === undefined) return FAIL;
  const a = typeOf(l, text);
  const b = typeOf(r, text);
  if (a === FAIL || b === FAIL) return FAIL;
  if ((a !== 'scalar' && a !== 'vector') || (b !== 'scalar' && b !== 'vector')) return FAIL;
  let op = '';
  for (let c = l.nextSibling; c !== null && c.from < r.from; c = c.nextSibling) {
    if (c.name !== 'BoolModifier' && c.name !== 'MatchingModifierClause') op = c.name;
  }
  const bool = n.getChild('BoolModifier') !== null;
  const matching = n.getChild('MatchingModifierClause');
  const bothVectors = a === 'vector' && b === 'vector';
  if (n.getChild('FillModifier') !== null || n.getChild('FillClause') !== null) return FAIL;
  if (bool && !COMPARISONS.has(op)) return FAIL;
  if (COMPARISONS.has(op) && a === 'scalar' && b === 'scalar' && !bool) return FAIL;
  if (SET_OPS.has(op) && !bothVectors) return FAIL;
  if (matching !== null) {
    if (!bothVectors) return FAIL;
    const grouping =
      matching.getChild('GroupLeft') !== null || matching.getChild('GroupRight') !== null;
    if (grouping && SET_OPS.has(op)) return FAIL;
  }
  return a === 'vector' || b === 'vector' ? 'vector' : 'scalar';
}

function aggregate(n: SyntaxNode, text: string): T {
  const opNode = n.getChild('AggregateOp');
  const op = opNode === null ? '' : text.slice(opNode.from, opNode.to);
  if (EXPERIMENTAL_AGGREGATES.has(op)) return FAIL;
  const args = n.getChild('FunctionCallBody')?.getChildren('Expr') ?? [];
  const wantParam = PARAM_SCALAR.has(op) || op === 'count_values';
  if (args.length !== (wantParam ? 2 : 1)) return FAIL;
  const types = args.map((a) => typeOf(a, text));
  if (types.at(-1) !== 'vector') return FAIL;
  if (wantParam && types[0] !== (op === 'count_values' ? 'string' : 'scalar')) return FAIL;
  return 'vector';
}

function call(n: SyntaxNode, text: string): T {
  const id = n.getChild('FunctionIdentifier');
  const name = id === null ? '' : text.slice(id.from, id.to);
  const fn = Object.hasOwn(STABLE_FUNCTIONS, name) ? STABLE_FUNCTIONS[name] : undefined;
  if (fn === undefined) return FAIL;
  const args = n.getChild('FunctionCallBody')?.getChildren('Expr') ?? [];
  const k = fn.argTypes.length;
  if (fn.variadic === 0 ? args.length !== k : args.length < k - 1) return FAIL;
  if (fn.variadic > 0 && args.length > k - 1 + fn.variadic) return FAIL;
  for (const [i, a] of args.entries()) {
    const t = typeOf(a, text);
    if (t === FAIL) return FAIL;
    if (fn.variadic === 0 && i >= k) continue;
    if (t !== fn.argTypes[Math.min(i, k - 1)]) return FAIL;
  }
  if (name === 'info') {
    const second = args[1];
    if (
      second !== undefined &&
      (second.name !== 'VectorSelector' || second.getChild('Identifier') !== null)
    )
      return FAIL;
  }
  return fn.returns;
}

/** `t(n)` of A.9, or FAIL. */
function typeOf(n: SyntaxNode, text: string): T {
  switch (n.name) {
    case 'NumberDurationLiteral':
      return 'scalar';
    case 'StringLiteral':
      return 'string';
    case 'VectorSelector':
      return vectorSelector(n, text);
    case 'MatrixSelector': {
      const inner = exprs(n)[0];
      return inner?.name === 'VectorSelector' && vectorSelector(inner, text) !== FAIL
        ? 'matrix'
        : FAIL;
    }
    case 'SubqueryExpr': {
      const inner = exprs(n)[0];
      return inner !== undefined && typeOf(inner, text) === 'vector' ? 'matrix' : FAIL;
    }
    case 'OffsetExpr':
    case 'StepInvariantExpr': {
      // `offset` and `@`: an instant or range vector selector, or a subquery, underneath.
      const base = modifierBase(n);
      const inner = exprs(n)[0];
      if (base === undefined || inner === undefined) return FAIL;
      if (!['VectorSelector', 'MatrixSelector', 'SubqueryExpr'].includes(base.name)) return FAIL;
      return typeOf(inner, text);
    }
    case 'AnchoredExpr':
    case 'SmoothedExpr': {
      const inner = exprs(n)[0];
      if (
        inner === undefined ||
        (inner.name !== 'VectorSelector' && inner.name !== 'MatrixSelector')
      )
        return FAIL;
      return typeOf(inner, text);
    }
    case 'ParenExpr': {
      const inner = exprs(n)[0];
      return inner === undefined ? FAIL : typeOf(inner, text);
    }
    case 'UnaryExpr': {
      const inner = exprs(n)[0];
      const t = inner === undefined ? FAIL : typeOf(inner, text);
      return t === 'scalar' || t === 'vector' ? t : FAIL;
    }
    case 'BinaryExpr':
      return binary(n, text);
    case 'AggregateExpr':
      return aggregate(n, text);
    case 'FunctionCall':
      return call(n, text);
  }
  return FAIL;
}

/** The server parser's type rules on a Lezer tree (A.9): false when the server would refuse. */
export function typeCheck(tree: Tree, text: string): boolean {
  const c = tree.cursor();
  do {
    if (c.type.isError) return false;
  } while (c.next());
  const top = tree.topNode.getChildren('Expr');
  return top.length === 1 && top[0] !== undefined && typeOf(top[0], text) !== FAIL;
}

/** The stub's shape of `text`: Lezer's, in bytes, when the type check passes; else unknown. */
export function stubShape(text: string): ByteShape {
  if (!typeCheck(parser.parse(text), text)) return UNKNOWN;
  return byteShape(text, analysePromQL(text));
}
