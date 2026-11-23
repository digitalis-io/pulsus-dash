/**
 * The range an accepted PromQL completion replaces (plan #107 §3.4; T09 §4.4): measured again on
 * the current syntax tree at accept time, so a list filtered by the text before the caret still
 * replaces the whole token or value under it. Rows 1–4 and 6 are the package's own end rule
 * (`computeEndCompletePosition` in 0.316.0, which it does not export); row 0 guards a tree that does
 * not reach the caret, and row 5 is #66's rule for a label value that is not well closed: it ends
 * at the first unescaped quote, `}`, `,` or whitespace at or after the caret and gains its closing
 * quote.
 */
import {
  insertCompletionText,
  pickedCompletion,
  type Completion,
  type CompletionSection,
} from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import {
  FunctionCallBody,
  GroupingLabels,
  LabelMatchers,
  MatrixSelector,
  QuotedLabelMatcher,
  StringLiteral,
  SubqueryExpr,
  UnquotedLabelMatcher,
} from '@prometheus-io/lezer-promql';

export interface ReplaceRange {
  /** Accepting replaces [from, end); end ≥ pos. */
  readonly end: number;
  /** Appended to the inserted text: the value's quote, or ''. */
  readonly suffix: '' | '"' | "'" | '`';
}

type Quote = ReplaceRange['suffix'];

/** §3.4 row 3: inside empty brackets the closing one is kept. */
const BRACKETED: ReadonlySet<number> = new Set([
  LabelMatchers,
  GroupingLabels,
  FunctionCallBody,
  MatrixSelector,
  SubqueryExpr,
]);
const STOP: ReadonlySet<string> = new Set(['"', "'", '`', '}', ',', ' ', '\t', '\r', '\n']);
const SPACE = /\s/;

const quoteOf = (c: string | undefined): Quote => (c === '"' || c === "'" || c === '`' ? c : '');

/** The number of `\` immediately before index `i`, counted back to `floor + 1`. */
function backslashesBefore(doc: string, i: number, floor: number): number {
  let k = 0;
  for (let j = i - 1; j > floor && doc[j] === '\\'; j--) k++;
  return k;
}

/** The first unescaped stop at or after `pos` in the value whose opening quote is at `from`. */
function stopAt(doc: string, from: number, pos: number, q: Quote): number {
  let j = pos;
  if (q === '`') {
    // Raw strings have no escapes.
    while (j < doc.length && !STOP.has(doc[j] ?? '')) j += 1;
    return Math.min(j, doc.length);
  }
  if (backslashesBefore(doc, pos, from) % 2 === 1) j = pos + 1;
  while (j < doc.length) {
    const c = doc[j] ?? '';
    if (c === '\\') j += 2;
    else if (STOP.has(c)) break;
    else j += 1;
  }
  return Math.min(j, doc.length);
}

/** The value [from, to) is closed by an unescaped `q`, and `}` or `,` is the next non-space. */
function wellClosed(doc: string, from: number, to: number, q: Quote): boolean {
  if (to - from < 2 || doc[to - 1] !== q) return false;
  if (q !== '`' && backslashesBefore(doc, to - 1, from) % 2 === 1) return false;
  let j = to;
  while (j < doc.length && SPACE.test(doc[j] ?? '')) j += 1;
  return doc[j] === '}' || doc[j] === ',';
}

/** The range under the caret `pos` on `state`, measured on its syntax tree. */
export function replaceRange(state: EditorState, pos: number): ReplaceRange {
  const tree = syntaxTree(state);
  if (tree.length < pos) return { end: pos, suffix: '' };
  const n = tree.resolve(pos, -1);
  const id = n.type.id;
  const at = (end: number, suffix: Quote = ''): ReplaceRange => ({
    end: Math.max(end, pos),
    suffix,
  });
  if (id === 0) return at(pos);
  if (
    id === FunctionCallBody &&
    pos >= n.to &&
    n.from < n.to &&
    state.sliceDoc(n.to - 1, n.to) === ')'
  ) {
    return at(pos);
  }
  if (BRACKETED.has(id)) return at(n.to - 1);
  const parent = n.parent?.type.id;
  if (id === StringLiteral && (parent === UnquotedLabelMatcher || parent === QuotedLabelMatcher)) {
    const doc = state.doc.toString();
    const q = quoteOf(doc[n.from]);
    if (wellClosed(doc, n.from, n.to, q)) return at(n.to - 1);
    const e = stopAt(doc, n.from, pos, q);
    return at(e, doc[e] === q ? '' : q);
  }
  return at(n.to);
}

/**
 * `o` with `section`, and `apply` replaced by a function `(view, completion, from, to)` that reads
 * `r = replaceRange(view.state, to)`. If `o.apply` is a function (a snippet), it is called as
 * `o.apply(view, completion, from, r.end)`. Otherwise `text = (o.apply ?? o.label) + r.suffix`
 * is dispatched as `{...insertCompletionText(view.state, text, from, r.end), annotations:
 * pickedCompletion.of(completion)}`.
 */
export function replacing(o: Completion, section: CompletionSection): Completion {
  const own = o.apply;
  return {
    ...o,
    section,
    apply: (view: EditorView, completion: Completion, from: number, to: number) => {
      const r = replaceRange(view.state, to);
      if (typeof own === 'function') {
        own(view, completion, from, r.end);
        return;
      }
      const text = (own ?? o.label) + r.suffix;
      view.dispatch({
        ...insertCompletionText(view.state, text, from, r.end),
        annotations: pickedCompletion.of(completion),
      });
    },
  };
}
