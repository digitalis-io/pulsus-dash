/**
 * The StubApi planner mirror's shape (plan #112 §3.7, §4.3, A.9): the Lezer shape of the query
 * when the stub type check passes, else the unknown shape, in UTF-8 byte offsets. Lezer parses
 * syntax only, while the server's upstream parser also type-checks and refuses experimental
 * syntax; `typeCheck` mirrors those rules on the Lezer tree, so the stub gives the server's shape.
 * Loaded lazily by `StubApi`, so Lezer stays out of the initial chunk.
 *
 * String literals are read by the upstream lexer's escape rules (plan #118 §4.4), and a CR that
 * ends a `#` comment is read as an LF before the Lezer parse (`endCommentsAtCR`).
 *
 * Known limitations (stub mode only, never the http path; A.9): regular-expression dialects (the
 * server compiles RE2; here the empty string is tested with JavaScript's engine and no pattern is
 * refused), number or duration lexing differences, and a Lezer grammar that lags or leads the
 * server's parser release.
 */
import type { SyntaxNode, Tree } from '@lezer/common';
import { parser } from '@prometheus-io/lezer-promql';
import { analysePromQL } from '../../editor/lang/promql/promql';
import type { ValueType } from '../../editor/lang/types';
import { byteShape, endCommentsAtCR, type ByteShape } from './plan';
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

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });

const SIMPLE_ESCAPES: Readonly<Record<string, number>> = {
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
  '\\': 0x5c,
};

/** The value of `n` digits of `base` at `body[i]`, or null. */
function digits(body: Uint8Array, i: number, n: number, base: 8 | 16): number | null {
  if (i + n > body.length) return null;
  let v = 0;
  for (let k = i; k < i + n; k++) {
    const d = Number.parseInt(String.fromCharCode(body[k] ?? 0), base);
    if (Number.isNaN(d)) return null;
    v = v * base + d;
  }
  return v;
}

function holdsFffd(b: Uint8Array): boolean {
  for (let i = 0; i + 2 < b.length; i++)
    if (b[i] === 0xef && b[i + 1] === 0xbf && b[i + 2] === 0xbd) return true;
  return false;
}

/**
 * A PromQL string literal's value by the upstream lexer and strutil.Unquote rules (plan #118
 * §4.4), or null when the upstream parser would refuse the literal. @internal exported for its
 * table test.
 */
export function unquote(lit: string): string | null {
  const q = lit[0];
  if (lit.length < 2 || lit.at(-1) !== q || (q !== '"' && q !== "'" && q !== '`')) return null;
  const body = encoder.encode(lit.slice(1, -1));
  // lexString and lexRawString refuse utf8.RuneError, which a valid U+FFFD decodes to.
  if (holdsFffd(body)) return null;
  if (q === '`') return body.includes(0x60) ? null : decoder.decode(body);
  const open = q.charCodeAt(0);
  const out: number[] = [];
  for (let i = 0; i < body.length;) {
    const b = body[i] ?? 0;
    if (b === 0x0a || b === open) return null;
    if (b !== 0x5c) {
      out.push(b);
      i++;
      continue;
    }
    const c = body[i + 1];
    if (c === undefined) return null;
    const ch = String.fromCharCode(c);
    i += 2;
    const simple = Object.hasOwn(SIMPLE_ESCAPES, ch) ? SIMPLE_ESCAPES[ch] : undefined;
    if (simple !== undefined) out.push(simple);
    else if (c === open) out.push(c);
    else if (ch === 'x') {
      const v = digits(body, i, 2, 16);
      if (v === null) return null;
      out.push(v);
      i += 2;
    } else if (c >= 0x30 && c <= 0x37) {
      const v = digits(body, i - 1, 3, 8);
      if (v === null || v > 255) return null;
      out.push(v);
      i += 2;
    } else if (ch === 'u' || ch === 'U') {
      const n = ch === 'u' ? 4 : 8;
      const v = digits(body, i, n, 16);
      if (v === null || v > 0x10ffff || (v >= 0xd800 && v <= 0xdfff)) return null;
      out.push(...encoder.encode(String.fromCodePoint(v)));
      i += n;
    } else return null;
  }
  return decoder.decode(new Uint8Array(out));
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
    // typeCheck has refused every literal that does not unquote.
    const value = (n: SyntaxNode) => unquote(slice(n.getChild('StringLiteral'))) ?? '';
    if (m.name === 'UnquotedLabelMatcher') {
      out.push({
        label: slice(m.getChild('LabelName')),
        op: slice(m.getChild('MatchOp')),
        value: value(m),
      });
    } else if (m.name === 'QuotedLabelMatcher') {
      const name = m.getChild('QuotedLabelName');
      out.push({
        label: name === null ? '' : (unquote(slice(name.getChild('StringLiteral'))) ?? ''),
        op: slice(m.getChild('MatchOp')),
        value: value(m),
      });
    } else if (m.name === 'QuotedLabelName') {
      // `{"name"}`: the metric name in quoted form.
      out.push({ label: '__name__', op: '=', value: value(m) });
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

/**
 * The server parser's type rules on a Lezer tree (A.9): false when the server would refuse,
 * including a string literal its lexer refuses (plan #118 §4.4).
 */
export function typeCheck(tree: Tree, text: string): boolean {
  const c = tree.cursor();
  do {
    if (c.type.isError) return false;
    if (c.name === 'StringLiteral' && unquote(text.slice(c.from, c.to)) === null) return false;
  } while (c.next());
  const top = tree.topNode.getChildren('Expr');
  return top.length === 1 && top[0] !== undefined && typeOf(top[0], text) !== FAIL;
}

/**
 * The stub's shape of `text`: Lezer's, in bytes, when the type check passes; else unknown. It reads
 * `endCommentsAtCR(text)`, which keeps every offset, so a CR ends a comment as upstream.
 */
export function stubShape(text: string): ByteShape {
  const t = endCommentsAtCR(text);
  if (!typeCheck(parser.parse(t), t)) return UNKNOWN;
  return byteShape(t, analysePromQL(t));
}
