/**
 * The StubApi mirror of the server's `vars` package (plan #289 §3.4, T07-031): the forms of a
 * variable value, their bounds, how a structured value is written in its context, the token
 * context of a query and the regex position rules. The server's probe guard is not mirrored: the
 * stub relies on the server for it (the fixture's `server_only` cases).
 */
import type { VarValue } from '../types';

export type CtxKind = 'none' | 'eq' | 're' | 'top';

export interface Ctx {
  readonly kind: CtxKind;
  readonly where: string;
}

export const WHERE = {
  topLevel: 'top level',
  functionArgument: 'function argument',
  comment: 'comment',
  orFilter: 'or filter',
  patternFilter: 'pattern filter',
  equality: 'equality match',
  regex: 'regex',
  regexClass: 'regex class',
  regexEscape: 'regex escape',
  regexQuoted: 'regex quoted text',
} as const;

/** The LogQL stages whose strings and references are refused, named by their keyword. */
export const STAGE_KEYWORDS: readonly string[] = [
  'json',
  'logfmt',
  'regexp',
  'pattern',
  'unpack',
  'line_format',
  'label_format',
  'unwrap',
  'drop',
  'keep',
  'decolorize',
  'distinct',
];

export const MAX_VALUE_BYTES = 4096;
export const MAX_VALUES = 200;
export const MAX_SELECTION_BYTES = 65_536;

const encoder = new TextEncoder();
const utf8 = (s: string): number => encoder.encode(s).length;

export const isLegacy = (v: VarValue): v is string => typeof v === 'string';

/** UTF-8 bytes of `vs` as `JSON.stringify` writes it (the server's `SelectionBytes`). */
export function selectionBytes(vs: readonly string[]): number {
  return utf8(JSON.stringify(vs));
}

/** Row 5 of a value (`vars.Check`). */
export function checkValue(v: VarValue): boolean {
  if (isLegacy(v)) return utf8(v) <= MAX_VALUE_BYTES;
  if ('all' in v) return v.all.length > 0 && utf8(v.all) <= MAX_VALUE_BYTES;
  return (
    v.values.length >= 1 &&
    v.values.length <= MAX_VALUES &&
    v.values.every((s) => utf8(s) <= MAX_VALUE_BYTES) &&
    selectionBytes(v.values) <= MAX_SELECTION_BYTES
  );
}

/** The message of a refused value (`vars.RangeMessage`). */
export function rangeMessage(v: VarValue): string {
  if (isLegacy(v)) return 'a variable value must be UTF-8 and at most 4096 bytes';
  if ('all' in v) return "a variable's all value must be UTF-8 and 1 to 4096 bytes";
  return 'a variable must have 1 to 200 values, each UTF-8 and at most 4096 bytes, and at most 65536 bytes in all';
}

/** Go's `regexp.QuoteMeta`. */
export function quoteMeta(s: string): string {
  return s.replace(/[\\.+*?()|[\]{}^$]/g, '\\$&');
}

const group = (vs: readonly string[]): string => `(?-i:(?:${vs.map(quoteMeta).join('|')}))`;

const HEX = /^0[xX][0-9a-fA-F]+$/;
const DEC = /^([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?$/;
const DURATION = /^([0-9]+(ms|s|m|h|d|w|y))+$/;

/** An unsigned number or a duration (`vars.TopToken`). */
export function topToken(s: string): boolean {
  return HEX.test(s) || DEC.test(s) || DURATION.test(s);
}

/** `vars.Render`: the text before the string encoding, or null when refused. */
export function renderValue(v: VarValue, c: Ctx): string | null {
  if (isLegacy(v)) return v;
  if ('all' in v) return c.kind === 're' ? v.all : null;
  const vs = v.values;
  switch (c.kind) {
    case 're':
      return vs.length > 0 ? group(vs) : null;
    case 'eq':
      return vs.length === 1 ? (vs[0] ?? null) : null;
    case 'top':
      return vs.length === 1 && topToken(vs[0] ?? '') ? (vs[0] ?? null) : null;
    default:
      return null;
  }
}

type TokKind = 'none' | 'ident' | 'op' | 'string' | 'ref' | 'punct';
interface Token {
  kind: TokKind;
  text: string;
}
const NO_TOKEN: Token = { kind: 'none', text: '' };
const STAGE_LINE = '|line';

const isIdentByte = (c: number): boolean =>
  c === 0x5f ||
  c === 0x3a ||
  (c >= 0x61 && c <= 0x7a) ||
  (c >= 0x41 && c <= 0x5a) ||
  (c >= 0x30 && c <= 0x39);
const isOpByte = (c: number): boolean =>
  c === 0x3d || c === 0x21 || c === 0x7e || c === 0x7c || c === 0x3c || c === 0x3e;
const isSpace = (c: number): boolean =>
  c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0c || c === 0x0b;

const ctxOf = (kind: CtxKind): Ctx =>
  kind === 'eq'
    ? { kind, where: WHERE.equality }
    : kind === 're'
      ? { kind, where: WHERE.regex }
      : kind === 'top'
        ? { kind, where: WHERE.topLevel }
        : { kind: 'none', where: WHERE.topLevel };
const none = (where: string): Ctx => ({ kind: 'none', where });
const eqOrRe = (op: string): CtxKind | null =>
  op === '=' || op === '!=' ? 'eq' : op === '=~' || op === '!~' ? 're' : null;

/** The token context of a query outside strings and comments (`vars.Tracker`). */
export class Tracker {
  private braces = 0;
  private parens = 0;
  private cur: Token = { ...NO_TOKEN };
  private last: Token = NO_TOKEN;
  private prev: Token = NO_TOKEN;
  private stage = '';
  private stagePending = false;

  constructor(private readonly logql: boolean) {}

  private push(tok: Token): void {
    this.prev = this.last;
    this.last = tok;
    if (!this.logql || this.braces > 0) return;
    if (tok.kind === 'op' && tok.text === '|') {
      this.stage = '';
      this.stagePending = true;
    } else if (tok.kind === 'op' && (tok.text === '|=' || tok.text === '|~' || tok.text === '|>')) {
      this.stage = STAGE_LINE;
      this.stagePending = false;
    } else if (tok.kind === 'ident' && this.stagePending) {
      this.stage = tok.text;
      this.stagePending = false;
    } else if (this.stagePending) this.stagePending = false;
  }

  end(): void {
    if (this.cur.kind !== 'none') {
      this.push(this.cur);
      this.cur = { ...NO_TOKEN };
    }
  }

  byte(c: number): void {
    if (isSpace(c)) {
      this.end();
      return;
    }
    if (isIdentByte(c) || isOpByte(c)) {
      const k: TokKind = isOpByte(c) ? 'op' : 'ident';
      if (this.cur.kind !== k) {
        this.end();
        this.cur = { kind: k, text: '' };
      }
      if (this.cur.text.length < 16) this.cur.text += String.fromCharCode(c);
      return;
    }
    this.end();
    if (c === 0x7b) this.braces++;
    else if (c === 0x7d) this.braces = Math.max(0, this.braces - 1);
    else if (c === 0x28) this.parens++;
    else if (c === 0x29) this.parens = Math.max(0, this.parens - 1);
    this.push({ kind: 'punct', text: String.fromCharCode(c) });
  }

  private keywordStage(): string {
    return STAGE_KEYWORDS.includes(this.stage) ? this.stage : '';
  }

  private fallback(): Ctx {
    const k = this.keywordStage();
    if (k !== '') return none(k);
    return none(this.parens > 0 ? WHERE.functionArgument : WHERE.topLevel);
  }

  private labelFilter(kind: CtxKind): Ctx {
    const k = this.keywordStage();
    if (k !== '') return none(k);
    if (this.stage === '' || this.stage === STAGE_LINE) return this.fallback();
    return ctxOf(kind);
  }

  /** The context of a string opening now; `endString` when it closes. */
  string(): Ctx {
    this.end();
    const { last, prev } = this;
    if (this.braces > 0) {
      const k = last.kind === 'op' ? eqOrRe(last.text) : null;
      return k === null ? this.fallback() : ctxOf(k);
    }
    if (!this.logql) return this.fallback();
    if (last.kind === 'op') {
      switch (last.text) {
        case '|=':
          return ctxOf('eq');
        case '|~':
          return ctxOf('re');
        case '|>':
        case '!>':
          return none(WHERE.patternFilter);
        case '!=':
        case '!~': {
          const k = eqOrRe(last.text) ?? 'eq';
          if (prev.kind === 'ident') return this.labelFilter(k);
          const kw = this.keywordStage();
          return kw !== '' ? none(kw) : ctxOf(k);
        }
        case '=':
        case '=~':
          return this.labelFilter(eqOrRe(last.text) ?? 'eq');
        default:
          return this.fallback();
      }
    }
    if (last.kind === 'ident' && last.text === 'or') return none(WHERE.orFilter);
    if (last.kind === 'ident' && STAGE_KEYWORDS.includes(last.text)) return none(last.text);
    return this.fallback();
  }

  endString(): void {
    this.push({ kind: 'string', text: '' });
  }

  /** The context of a reference outside strings and comments. */
  ref(): Ctx {
    this.end();
    let c: Ctx;
    if (!this.logql) c = ctxOf('top');
    else {
      const k = this.keywordStage();
      c = none(k !== '' ? k : WHERE.topLevel);
    }
    this.push({ kind: 'ref', text: '' });
    return c;
  }
}

/** One part of a regex string as it decodes. */
export interface RegexPart {
  readonly text: string;
  readonly structured: boolean;
}

/** The regex position rules over the parts of one regex string (`vars.CheckRegex`, no guard). */
export function checkRegex(parts: readonly RegexPart[]): { part: number; where: string }[] {
  const out: { part: number; where: string }[] = [];
  let esc = false;
  let quoted = false;
  let qSlash = false;
  let cls = false;
  let classItem = false;
  let classNeg = false;
  let brace = false;
  parts.forEach((p, k) => {
    if (p.structured) {
      const w = esc
        ? WHERE.regexEscape
        : quoted
          ? WHERE.regexQuoted
          : cls || brace
            ? WHERE.regexClass
            : '';
      if (w !== '') out.push({ part: k, where: w });
    }
    const t = p.text;
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (quoted) {
        if (qSlash && c === 'E') quoted = false;
        qSlash = c === '\\';
      } else if (esc) {
        esc = false;
        if (c === 'Q' && !cls) {
          quoted = true;
          qSlash = false;
        }
        if (cls) classItem = true;
      } else if (c === '\\') esc = true;
      else if (cls) {
        if (c === '^' && !classItem && !classNeg) classNeg = true;
        else if (c === ']' && classItem) cls = false;
        else if (c === '[' && t[i + 1] === ':') {
          const end = t.indexOf(':]', i + 2);
          if (end >= 0) i = end + 1;
          classItem = true;
        } else classItem = true;
      } else if (brace) {
        if (c === '}') brace = false;
      } else if (c === '[') {
        cls = true;
        classItem = false;
        classNeg = false;
      } else if (c === '{') brace = true;
    }
  });
  return out;
}

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  a: '\x07',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '\\': '\\',
};

/**
 * The text of a quoted string's raw content as Go's `strconv.UnquoteChar` reads it with `quote`,
 * or null when an escape is not one it reads.
 */
export function unquote(raw: string, quote: string): string | null {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i] ?? '';
    if (c !== '\\') {
      out += c;
      continue;
    }
    const e = raw[i + 1];
    if (e === undefined) return null;
    const simple = SIMPLE_ESCAPES[e];
    if (simple !== undefined) {
      out += simple;
      i++;
    } else if (e === quote) {
      out += e;
      i++;
    } else if (e === 'x' || e === 'u' || e === 'U') {
      const n = e === 'x' ? 2 : e === 'u' ? 4 : 8;
      const hex = raw.slice(i + 2, i + 2 + n);
      if (!new RegExp(`^[0-9a-fA-F]{${String(n)}}$`).test(hex)) return null;
      const v = parseInt(hex, 16);
      if (e !== 'x' && (v > 0x10ffff || (v >= 0xd800 && v <= 0xdfff))) return null;
      out += e === 'x' ? String.fromCharCode(v) : String.fromCodePoint(v);
      i += 1 + n;
    } else if (e >= '0' && e <= '7') {
      const oct = raw.slice(i + 1, i + 4);
      if (!/^[0-7]{3}$/.test(oct)) return null;
      const v = parseInt(oct, 8);
      if (v > 255) return null;
      out += String.fromCharCode(v);
      i += 3;
    } else return null;
  }
  return out;
}

/** A reference refused for its context (where set) or by row 7b (where ''). */
export interface Refusal {
  readonly name: string;
  readonly at: number;
  readonly where: string;
}

/** An open regex string's parts (`vars.RegexString`); `raw` slices are UTF-8 bytes. */
export class RegexString {
  private readonly parts: RegexPart[] = [];
  private readonly refs: { name: string; at: number; part: number }[] = [];
  private bad = false;
  private size = 0;

  constructor(
    private readonly quote: string,
    private from: number,
  ) {}

  private decode(raw: Uint8Array, to: number): void {
    const chunk = new TextDecoder().decode(raw.subarray(this.from, to));
    if (chunk === '' || this.bad) return;
    const text = this.quote === '' ? chunk : unquote(chunk, this.quote);
    if (text === null) {
      this.bad = true;
      return;
    }
    this.parts.push({ text, structured: false });
    this.size += utf8(text);
  }

  add(raw: Uint8Array, at: number, end: number, name: string, text: string, structured: boolean) {
    this.decode(raw, at);
    this.from = end;
    if (structured) this.refs.push({ name, at, part: this.parts.length });
    this.parts.push({ text, structured });
    this.size += utf8(text);
  }

  close(raw: Uint8Array, to: number, maxSize: number): Refusal[] {
    this.decode(raw, to);
    this.from = to;
    if (this.refs.length === 0 || this.size > maxSize) return [];
    if (this.bad) return this.refs.map((r) => ({ name: r.name, at: r.at, where: WHERE.regex }));
    const out: Refusal[] = [];
    for (const f of checkRegex(this.parts)) {
      const r = this.refs.find((x) => x.part === f.part);
      if (r !== undefined) out.push({ name: r.name, at: r.at, where: f.where });
    }
    return out;
  }
}

/** The refused names, distinct, by first refused reference, and the first one's place. */
export function unrepresentable(rs: readonly Refusal[]): { names: string[]; where: string } {
  const sorted = [...rs].sort((a, b) => a.at - b.at);
  const names: string[] = [];
  for (const r of sorted) if (!names.includes(r.name)) names.push(r.name);
  return { names, where: sorted[0]?.where ?? '' };
}

/** The refusal message of row 7b and T07-031. */
export function unrepresentableMessage(names: readonly string[], where: string): string {
  return `the value of variable $${names.join(', $')} cannot be written where it is referenced${where === '' ? '' : ` (in ${where})`}`;
}
