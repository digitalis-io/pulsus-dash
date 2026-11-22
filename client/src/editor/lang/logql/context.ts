/**
 * The LogQL caret context (plan #66 Part A §3.4, Appendix A.3; T09 §4.4): what the caret is in,
 * the range an accepted option replaces (`from`…`end`), and the lookup scope of a label: the
 * other complete matchers of the selector, as written. A matcher whose value holds a variable
 * reference is left out of the scope: the browser never substitutes (T09-010, ADR-0021 §2).
 */
import { advance, lexLogQL, startLex, type Token, type TokenKind } from './lexer';

/** `from` ≤ caret ≤ `end`: accepting an option replaces [from, end) (`complete.ts`). */
export type LogCaretContext =
  | {
      readonly kind: 'labelName';
      readonly from: number;
      readonly end: number;
      readonly selector: string | null;
    }
  | {
      readonly kind: 'labelValue';
      readonly from: number;
      readonly end: number;
      readonly label: string;
      readonly quote: '"' | '`' | null;
      readonly selector: string | null;
      /** Accepting appends `quote`: the value's closing quote is not at `end`. false when `quote` is null. */
      readonly closeQuote: boolean;
    }
  | {
      readonly kind: 'grouping';
      readonly from: number;
      readonly end: number;
      readonly selector: string | null;
    }
  | { readonly kind: 'stage'; readonly from: number; readonly end: number }
  | { readonly kind: 'function'; readonly from: number; readonly end: number }
  | { readonly kind: 'duration'; readonly from: number; readonly end: number }
  | { readonly kind: 'none' };

/** A variable or macro reference as the server's substitution reads it (`$name`, `${name}`). */
export const VAR_REF = /\$[A-Za-z_{]/;

const NONE: LogCaretContext = { kind: 'none' };
/** An unclosed or not well closed value ends at the first of these after the caret. */
const STOP = new Set(['"', '`', '}', ',', ' ', '\t', '\r', '\n']);
/** After one of these words, an operand (a function) follows. */
const OPERAND_WORDS = new Set(['and', 'or', 'unless', 'bool']);
const OPENERS = new Set<TokenKind>(['lbrace', 'lparen', 'lbracket']);
const CLOSERS = new Set<TokenKind>(['rbrace', 'rparen', 'rbracket']);

const significant = (t: Token) => t.kind !== 'space' && t.kind !== 'comment';
const isString = (t: Token) => t.kind === 'string' || t.kind === 'rawString';
const isDigit = (c: string) => c.length === 1 && c >= '0' && c <= '9';

/** The index of the first significant token after `i`, or -1. */
function nextSignificant(tokens: readonly Token[], i: number): number {
  for (let j = i + 1; j < tokens.length; j++) {
    const t = tokens[j];
    if (t !== undefined && significant(t)) return j;
  }
  return -1;
}

/**
 * The complete matchers of the selector opened at `tokens[open]` other than `skip` (an index of
 * that matcher's name token) and other than those whose value matches `VAR_REF`, as `{` + source
 * slices joined by `, ` + `}`; null if none.
 */
export function selectorOf(
  text: string,
  tokens: readonly Token[],
  open: number,
  skip: number | null,
): string | null {
  const parts: string[] = [];
  let depth = 0;
  for (let i = open + 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === undefined || !significant(t)) continue;
    if (OPENERS.has(t.kind)) {
      depth += 1;
      continue;
    }
    if (CLOSERS.has(t.kind)) {
      if (depth > 0) depth -= 1;
      else if (t.kind === 'rbrace') break;
      continue;
    }
    if (depth !== 0 || t.kind !== 'ident') continue;
    const op = nextSignificant(tokens, i);
    const v = op < 0 ? -1 : nextSignificant(tokens, op);
    const opTok = tokens[op];
    const value = tokens[v];
    if (opTok?.kind !== 'matchOp' || value === undefined || !isString(value) || !value.closed) {
      continue;
    }
    if (i !== skip && !VAR_REF.test(text.slice(value.from, value.to))) {
      parts.push(text.slice(t.from, value.to));
    }
    i = v;
  }
  return parts.length === 0 ? null : `{${parts.join(', ')}}`;
}

/** `selectorOf` of the first `lbrace` of the text, or null. */
export function firstSelector(text: string, tokens: readonly Token[]): string | null {
  const open = tokens.findIndex((t) => t.kind === 'lbrace');
  return open < 0 ? null : selectorOf(text, tokens, open, null);
}

/** The first index at or after `pos` whose character is in `STOP`, else the text's end. */
function stopAt(text: string, pos: number): number {
  for (let j = pos; j < text.length; j++) if (STOP.has(text.charAt(j))) return j;
  return text.length;
}

export function caretContext(text: string, pos: number): LogCaretContext {
  const tokens = lexLogQL(text);
  // The token that ends at or runs over the caret (tokens are contiguous: at most one). A token
  // that starts at the caret is never the caret's: a caret before a token inserts.
  let k = -1;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === undefined || t.from >= pos) break;
    if (pos <= t.to) {
      k = i;
      break;
    }
  }
  const at = tokens[k];
  if (at?.kind === 'comment') return NONE;
  let cur: Token | null = null;
  if (at !== undefined) {
    if (isString(at)) {
      if (pos < at.to || !at.closed) cur = at;
    } else if (
      at.kind === 'ident' ||
      at.kind === 'number' ||
      at.kind === 'duration' ||
      (at.kind === 'error' && isDigit(text.charAt(at.from)))
    ) {
      cur = at;
    }
  }

  // The mode stack before the caret's token, the last two significant tokens and the `lbrace`
  // of each open frame.
  const limit = cur?.from ?? pos;
  const st = startLex();
  const opens: number[] = [];
  let s1 = -1;
  let s2 = -1;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === undefined || t.to > limit) break;
    if (!significant(t)) continue;
    const before = st.stack.length;
    advance(st, t, text);
    if (st.stack.length > before) opens.push(i);
    else if (st.stack.length < before) opens.pop();
    s2 = s1;
    s1 = i;
  }
  const frame = st.stack.at(-1) ?? null;
  const open = opens.at(-1) ?? -1;
  const t1 = tokens[s1];
  const t2 = tokens[s2];
  const s1Kind = t1?.kind ?? null;
  const s1Text = t1 === undefined ? '' : text.slice(t1.from, t1.to);
  const afterMatcher = frame === 'brace' && s1Kind === 'matchOp' && t2?.kind === 'ident';
  const label = t2 === undefined ? '' : text.slice(t2.from, t2.to);

  if (cur !== null && isString(cur)) {
    if (!afterMatcher) return NONE;
    const quote = text.charAt(cur.from) === '`' ? '`' : '"';
    const after = tokens[nextSignificant(tokens, k)];
    const wellClosed = cur.closed && (after?.kind === 'rbrace' || after?.kind === 'comma');
    const end = wellClosed ? cur.to - 1 : stopAt(text, pos);
    return {
      kind: 'labelValue',
      from: cur.from + 1,
      end,
      label,
      quote,
      selector: selectorOf(text, tokens, open, s2),
      closeQuote: !wellClosed && text.charAt(end) !== quote,
    };
  }

  const word = cur === null || cur.kind === 'ident';
  const from = cur?.from ?? pos;
  const end = cur?.to ?? pos;
  if (word && afterMatcher) {
    return {
      kind: 'labelValue',
      from,
      end,
      label,
      quote: null,
      selector: selectorOf(text, tokens, open, s2),
      closeQuote: false,
    };
  }
  if (word && frame === 'brace' && (s1Kind === 'lbrace' || s1Kind === 'comma')) {
    return {
      kind: 'labelName',
      from,
      end,
      selector: selectorOf(text, tokens, open, cur === null ? null : k),
    };
  }
  if (word && s1Kind === 'pipe') return { kind: 'stage', from, end };
  // `cur` is null or a word, number, duration or digit-led error here.
  if (frame === 'bracket') return { kind: 'duration', from, end };
  if (word && frame === 'group' && (s1Kind === 'lparen' || s1Kind === 'comma')) {
    return { kind: 'grouping', from, end, selector: firstSelector(text, tokens) };
  }
  if (
    word &&
    (frame === null || frame === 'paren') &&
    (s1Kind === null ||
      s1Kind === 'lparen' ||
      s1Kind === 'comma' ||
      s1Kind === 'arith' ||
      s1Kind === 'cmpOp' ||
      (s1Kind === 'ident' && OPERAND_WORDS.has(s1Text)))
  ) {
    return { kind: 'function', from, end };
  }
  return NONE;
}
