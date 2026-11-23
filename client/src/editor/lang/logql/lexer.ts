/**
 * The LogQL scanner (plan #66 Part A §3.3; T09-003): one context-free `scanAt` cuts LogQL into
 * tokens. It drives both the CodeMirror `StreamLanguage` (one line at a time, resumable through
 * `LexState`) and `lexLogQL`, the whole-text lexer of the caret context, so highlighting and
 * completion read the same tokens. `advance` keeps the mode stack (selector, parens, grouping,
 * range) that decides a label name's colour and a completion context. Nothing here decides whether
 * a query is valid: PulsusDB does (T09-002). LogQL has no comments (#121): a `#` outside a string is
 * one `error` token, as any other character LogQL does not use, and the scan goes on after it.
 * Never throws.
 */
import { GROUP_WORDS } from './grammar';

export type TokenKind =
  | 'space'
  | 'string'
  | 'rawString'
  | 'number'
  | 'duration'
  | 'bytes'
  | 'ident'
  | 'lbrace'
  | 'rbrace'
  | 'lparen'
  | 'rparen'
  | 'lbracket'
  | 'rbracket'
  | 'comma'
  | 'pipe'
  | 'lineFilter'
  | 'matchOp'
  | 'cmpOp'
  | 'arith'
  | 'error';

export interface Token {
  readonly kind: TokenKind;
  /** UTF-16 index; `from < to`. */
  readonly from: number;
  readonly to: number;
  /** Strings: the closing quote was seen; true for every other kind. */
  readonly closed: boolean;
}

export type Frame = 'brace' | 'paren' | 'group' | 'bracket';

/** The most frames the stack holds; deeper openers are counted in `depthOver`. */
export const MAX_DEPTH = 64;

export interface LexState {
  /** Innermost last; at most `MAX_DEPTH` frames. */
  stack: Frame[];
  /** Openers pushed beyond `MAX_DEPTH`, popped first. */
  depthOver: number;
  /** StreamLanguage only: a backtick string is open at the line end. */
  inRaw: boolean;
  /** The last significant token (not space). */
  prev: TokenKind | null;
  /** Its text when it is an ident, else null. */
  prevWord: string | null;
}

const DURATION = /^([0-9]+(\.[0-9]+)?(ns|us|µs|ms|s|m|h|d|w|y))+$/;
const BYTES = /^[0-9]+(\.[0-9]+)?([kKmMgGtTpPeE][iI]?)?[bB]$/;
const SINGLE: Readonly<Partial<Record<string, TokenKind>>> = {
  '{': 'lbrace',
  '}': 'rbrace',
  '(': 'lparen',
  ')': 'rparen',
  '[': 'lbracket',
  ']': 'rbracket',
  ',': 'comma',
  '+': 'arith',
  '-': 'arith',
  '*': 'arith',
  '/': 'arith',
  '%': 'arith',
  '^': 'arith',
};
const GROUP = new Set(GROUP_WORDS);

const tok = (kind: TokenKind, from: number, to: number, closed = true): Token => ({
  kind,
  from,
  to,
  closed,
});

const isSpace = (c: string) => c === ' ' || c === '\t' || c === '\r' || c === '\n';
const isDigit = (c: string) => c >= '0' && c <= '9' && c.length === 1;
const isLetter = (c: string) =>
  c.length === 1 && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'));
const isIdentStart = (c: string) => isLetter(c) || c === '_';
const isIdentPart = (c: string) => isIdentStart(c) || isDigit(c);
const isUnitPart = (c: string) => isLetter(c) || isDigit(c) || c === 'µ' || c === '.';

/** A backtick string from `from`, whose content starts at `start`: through the next backtick. */
function rawFrom(s: string, from: number, start: number): Token {
  const j = s.indexOf('`', start);
  return j < 0 ? tok('rawString', from, s.length, false) : tok('rawString', from, j + 1);
}

/** A double-quoted string at `i`: `\` escapes the next code unit; ends at the quote, a LF or the end. */
function quoted(s: string, i: number): Token {
  let j = i + 1;
  while (j < s.length) {
    const c = s.charAt(j);
    if (c === '"') return tok('string', i, j + 1);
    if (c === '\n') return tok('string', i, j, false);
    // A backslash before a LF escapes nothing: the string still ends at the LF, as on one line.
    j += c === '\\' && s.charAt(j + 1) !== '\n' ? 2 : 1;
  }
  return tok('string', i, s.length, false);
}

/** A number at `i`, with a unit run when a letter follows (duration, bytes, or an error). */
function numeric(s: string, i: number): Token {
  let j = i;
  while (isDigit(s.charAt(j))) j++;
  if (s.charAt(j) === '.' && isDigit(s.charAt(j + 1))) {
    j++;
    while (isDigit(s.charAt(j))) j++;
  }
  const next = s.charAt(j);
  if (!isLetter(next) && next !== 'µ') return tok('number', i, j);
  while (j < s.length && isUnitPart(s.charAt(j))) j++;
  const w = s.slice(i, j);
  if (DURATION.test(w)) return tok('duration', i, j);
  if (BYTES.test(w)) return tok('bytes', i, j);
  return tok('error', i, j);
}

/** The token at `s[i]` (`i < s.length`). `inRaw`: `s[i]` continues a backtick string from an earlier line. */
export function scanAt(s: string, i: number, inRaw: boolean): Token {
  if (inRaw) return rawFrom(s, i, i);
  const c = s.charAt(i);
  const d = s.charAt(i + 1);
  if (isSpace(c)) {
    let j = i + 1;
    while (j < s.length && isSpace(s.charAt(j))) j++;
    return tok('space', i, j);
  }
  if (c === '"') return quoted(s, i);
  if (c === '`') return rawFrom(s, i, i + 1);
  if (c === '|') {
    return d === '=' || d === '~' || d === '>'
      ? tok('lineFilter', i, i + 2)
      : tok('pipe', i, i + 1);
  }
  if (c === '!') {
    if (d === '>') return tok('lineFilter', i, i + 2);
    if (d === '=' || d === '~') return tok('matchOp', i, i + 2);
    return tok('error', i, i + 1);
  }
  if (c === '=') {
    if (d === '~') return tok('matchOp', i, i + 2);
    if (d === '=') return tok('cmpOp', i, i + 2);
    return tok('matchOp', i, i + 1);
  }
  if (c === '>' || c === '<') return tok('cmpOp', i, d === '=' ? i + 2 : i + 1);
  const single = SINGLE[c];
  if (single !== undefined) return tok(single, i, i + 1);
  if (isDigit(c)) return numeric(s, i);
  if (isIdentStart(c)) {
    let j = i + 1;
    while (isIdentPart(s.charAt(j))) j++;
    return tok('ident', i, j);
  }
  // One code point: a surrogate pair is one token.
  const cp = s.codePointAt(i) ?? 0;
  return tok('error', i, i + (cp > 0xffff ? 2 : 1));
}

/** Every token of `text`, contiguous: from 0 to `text.length`. */
export function lexLogQL(text: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const t = scanAt(text, i, false);
    out.push(t);
    i = t.to;
  }
  return out;
}

export function startLex(): LexState {
  return { stack: [], depthOver: 0, inRaw: false, prev: null, prevWord: null };
}

function push(st: LexState, f: Frame): void {
  if (st.stack.length >= MAX_DEPTH) st.depthOver += 1;
  else st.stack.push(f);
}

function close(st: LexState, ok: (f: Frame) => boolean): void {
  if (st.depthOver > 0) {
    st.depthOver -= 1;
    return;
  }
  const top = st.stack.at(-1);
  if (top !== undefined && ok(top)) st.stack.pop();
}

/** Applies one significant token: openers push, matching closers pop, `prev`/`prevWord` update. */
export function advance(st: LexState, tok: Token, text: string): void {
  switch (tok.kind) {
    case 'lbrace':
      push(st, 'brace');
      break;
    case 'lparen':
      push(st, st.prevWord !== null && GROUP.has(st.prevWord) ? 'group' : 'paren');
      break;
    case 'lbracket':
      push(st, 'bracket');
      break;
    case 'rbrace':
      close(st, (f) => f === 'brace');
      break;
    case 'rparen':
      close(st, (f) => f === 'paren' || f === 'group');
      break;
    case 'rbracket':
      close(st, (f) => f === 'bracket');
      break;
    default:
      break;
  }
  st.prev = tok.kind;
  st.prevWord = tok.kind === 'ident' ? text.slice(tok.from, tok.to) : null;
}
