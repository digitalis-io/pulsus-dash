/**
 * The StubApi LogQL planner mirror (plan #116 §3.7, ADR-0021 §4): the rules of the server's
 * `logs.Plan` for `npm run dev` and the tests, run against the shared fixture
 * `wire/fixtures/plan/logql.json` by `logsPlan.test.ts` as the Go planner is. Only `StubApi`
 * imports it (an ESLint rule forbids other importers): in http mode the server plans and the
 * client reads `planned`.
 *
 * The raw text is encoded once and planned on its UTF-8 bytes, as Go does: offsets, sizes, the
 * selector spans and the position map are in bytes. A `"…"` value is decoded by Go's
 * `strconv.Unquote` rules and a value written into one by the encoding table of plan #116 §4.2,
 * byte for byte as Go does.
 */
import type { LogqlPlannedQuery } from '../../data/decode';
import type { FieldError } from '../types';
import {
  formatDuration,
  MAX_RAW_BYTES,
  MAX_SENT_BYTES,
  MAX_VALUE_BYTES,
  MAX_VARS,
  rateWindowMs,
  utf8Length,
} from './plan';

export interface LogsPlanInputs {
  readonly query: string;
  readonly vars: Readonly<Record<string, string>>;
  readonly kind: 'range' | 'volume';
  readonly stepMs: number;
}

/** A stream selector: UTF-8 offsets into the text classified. */
export interface LogsSelector {
  readonly from: number;
  readonly to: number;
  readonly reserved: boolean;
}

export interface LogsClass {
  readonly source: 'pulsus_db' | 'virtual' | 'mixed';
  readonly reserved: readonly string[];
  readonly selectors: readonly LogsSelector[];
}

export interface LogsStubPlanned {
  readonly planned: LogqlPlannedQuery;
  /** The classification of `planned.query`: authoritative (plan #116 §3.2). */
  readonly class: LogsClass;
  toSource(sentByte: number): number | null;
}

/** A refusal, as the gateway's `logPlanError` writes it. */
export interface LogsStubPlanError {
  readonly status: 400 | 413;
  readonly message: string;
  readonly fields: readonly FieldError[];
  readonly hint?:
    { readonly reason: 'processing_cap' } | { readonly position: { readonly offset: number } };
  readonly planned?: LogqlPlannedQuery;
}

export interface LogsPrepared {
  /** The placeholder text: the byte guard and the early refusal read it, nothing sends it. */
  readonly substituted: string;
  readonly class: LogsClass;
  checkCap(stepMs: number): LogsStubPlanError | null;
  plan(stepMs: number): LogsStubPlanned | LogsStubPlanError;
}

/** The name the refusal reports (T07-020), the Go constant `logs.ReservedMatcher`. */
export const RESERVED_MATCHER = 'source="pulsus-dash"';

/** The processing cap (the request-body limit, T06-021). */
const MAX_EXPANDED_BYTES = 2 * 1024 * 1024;
const MAX_NAME_LEN = 64;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** `max(4 × step, step + 15 s, 60 s)`: PromQL's window at the same step. */
export function logsRateWindowMs(stepMs: number): number {
  return rateWindowMs(stepMs);
}

/** The largest of d, h, m, s that divides `ms` (> 0), else `<ms>ms`. */
export function logsFormatDuration(ms: number): string {
  return formatDuration(ms);
}

/** The range of the volume template: whole seconds as `<s>s` (#65), else `<ms>ms`. */
export function volumeRange(stepMs: number): string {
  return stepMs % 1000 === 0 ? `${String(stepMs / 1000)}s` : `${String(stepMs)}ms`;
}

const VOLUME_PREFIX = encoder.encode('sum by (level, detected_level) (count_over_time(');
const volumeSuffix = (stepMs: number): Uint8Array =>
  encoder.encode(`\n| drop __error__ [${volumeRange(stepMs)}]))`);

export function isLogsPlanError(x: unknown): x is LogsStubPlanError {
  return typeof x === 'object' && x !== null && 'status' in x && 'message' in x;
}

// The segment map (plan #112 §4.2, unchanged).
interface Segment {
  readonly sentFrom: number;
  readonly sentLen: number;
  readonly rawFrom: number;
  readonly rawLen: number;
  readonly kind: 'copy' | 'insert' | 'added';
}

function at(segs: readonly Segment[], total: number, s: number): number | null {
  if (!Number.isInteger(s) || s < 0) return null;
  for (const g of segs) {
    if (g.kind === 'added' || s < g.sentFrom || s >= g.sentFrom + g.sentLen) continue;
    return g.kind === 'copy' ? g.rawFrom + (s - g.sentFrom) : g.rawFrom;
  }
  const last = segs.at(-1);
  return last !== undefined && s === total && last.kind !== 'added'
    ? last.rawFrom + last.rawLen
    : null;
}

const DOLLAR = 0x24,
  BRACE_OPEN = 0x7b,
  BRACE_CLOSE = 0x7d,
  BACKSLASH = 0x5c,
  DQUOTE = 0x22,
  BACKTICK = 0x60,
  HASH = 0x23,
  LF = 0x0a,
  CR = 0x0d;

const isNameStart = (b: number | undefined): boolean =>
  b !== undefined && (b === 0x5f || (b >= 0x61 && b <= 0x7a) || (b >= 0x41 && b <= 0x5a));
const isNameByte = (b: number | undefined): boolean =>
  isNameStart(b) || (b !== undefined && b >= 0x30 && b <= 0x39);

/** A reference at raw[i] === '$': its name and end, or null ($ alone, ${ without a close). */
function reference(raw: Uint8Array, i: number): { name: string; end: number } | null {
  let j = i + 1;
  const braced = raw[j] === BRACE_OPEN;
  if (braced) j++;
  if (!isNameStart(raw[j])) return null;
  let k = j;
  while (isNameByte(raw[k])) k++;
  const name = decoder.decode(raw.subarray(j, k));
  if (braced) {
    if (raw[k] !== BRACE_CLOSE) return null;
    k++;
  }
  return { name, end: k };
}

const HEX = '0123456789abcdef';
const SIMPLE_ESCAPES: Readonly<Record<number, string>> = {
  0x22: '\\"',
  0x5c: '\\\\',
  0x07: '\\a',
  0x08: '\\b',
  0x0c: '\\f',
  0x0a: '\\n',
  0x0d: '\\r',
  0x09: '\\t',
  0x0b: '\\v',
};

/** The escape of byte b in a `"…"` string, or null when b is written as itself (§4.2). */
function dqEscape(b: number): string | null {
  const s = SIMPLE_ESCAPES[b];
  if (s !== undefined) return s;
  if (b < 0x20 || b === 0x7f) return `\\x${HEX[b >> 4] ?? '0'}${HEX[b & 0xf] ?? '0'}`;
  return null;
}

/** `encodeDQ` of the Go planner on bytes: Go's escapes for `"`, `\` and every ASCII control byte. */
function encodeDQ(v: Uint8Array): Uint8Array {
  let n = 0;
  for (const b of v) n += dqEscape(b)?.length ?? 1;
  if (n === v.length) return v;
  const out = new Uint8Array(n);
  let o = 0;
  for (const b of v) {
    const e = dqEscape(b);
    if (e === null) out[o++] = b;
    else for (let k = 0; k < e.length; k++) out[o++] = e.charCodeAt(k);
  }
  return out;
}

type LexState = 'none' | 'dq' | 'bq' | 'comment';

/** Row 7b: a value that cannot be written verbatim in state st. */
function representable(v: Uint8Array, st: LexState): boolean {
  if (st === 'bq') return !v.includes(BACKTICK) && !v.includes(CR);
  if (st === 'comment') return !v.includes(LF);
  return true;
}

interface Macros {
  readonly interval: Uint8Array;
  readonly rateInterval: Uint8Array;
}

const PLACEHOLDERS: Macros = { interval: encoder.encode('1s'), rateInterval: encoder.encode('1s') };

function macrosAt(stepMs: number): Macros {
  return {
    interval: encoder.encode(formatDuration(stepMs)),
    rateInterval: encoder.encode(formatDuration(rateWindowMs(stepMs))),
  };
}

interface Substitution {
  readonly size: number;
  readonly missing: readonly string[];
  readonly unrepresentable: readonly string[];
  readonly bytes: Uint8Array;
  readonly segs: readonly Segment[];
}

/** One scan of the raw bytes by the LogQL lexical rules (plan #116 §4.2). */
function substitute(
  raw: Uint8Array,
  vars: ReadonlyMap<string, Uint8Array>,
  m: Macros,
  build: boolean,
): Substitution {
  const parts: Uint8Array[] = [];
  const segs: Segment[] = [];
  const missing: string[] = [];
  const unrepresentable: string[] = [];
  let size = 0;
  let copyFrom = 0;
  const flush = (to: number) => {
    if (to <= copyFrom) return;
    if (build) {
      const last = segs.at(-1);
      if (
        last?.kind === 'copy' &&
        last.sentFrom + last.sentLen === size &&
        last.rawFrom + last.rawLen === copyFrom
      ) {
        segs[segs.length - 1] = {
          ...last,
          sentLen: last.sentLen + to - copyFrom,
          rawLen: last.rawLen + to - copyFrom,
        };
      } else
        segs.push({
          sentFrom: size,
          sentLen: to - copyFrom,
          rawFrom: copyFrom,
          rawLen: to - copyFrom,
          kind: 'copy',
        });
      parts.push(raw.subarray(copyFrom, to));
    }
    size += to - copyFrom;
  };
  let st: LexState = 'none';
  for (let i = 0; i < raw.length;) {
    const c = raw[i];
    if (c === DOLLAR) {
      const ref = reference(raw, i);
      if (ref === null) {
        i++;
        continue;
      }
      let value: Uint8Array | null = null;
      let isVar = false;
      if (ref.name === '__interval') value = m.interval;
      else if (ref.name === '__rate_interval') value = m.rateInterval;
      else if (!ref.name.startsWith('__') && ref.name.length <= MAX_NAME_LEN) {
        value = vars.get(ref.name) ?? null;
        isVar = value !== null;
        if (value === null && !missing.includes(ref.name)) missing.push(ref.name);
      }
      if (value === null) {
        i = ref.end;
        continue;
      }
      if (isVar && !representable(value, st) && !unrepresentable.includes(ref.name))
        unrepresentable.push(ref.name);
      flush(i);
      const v = st === 'dq' ? encodeDQ(value) : value;
      if (build) {
        segs.push({
          sentFrom: size,
          sentLen: v.length,
          rawFrom: i,
          rawLen: ref.end - i,
          kind: 'insert',
        });
        parts.push(v);
      }
      size += v.length;
      i = ref.end;
      copyFrom = ref.end;
      continue;
    }
    if (st === 'none') {
      if (c === DQUOTE) st = 'dq';
      else if (c === BACKTICK) st = 'bq';
      else if (c === HASH) st = 'comment';
    } else if (st === 'dq') {
      if (c === BACKSLASH) {
        // The escaped byte is skipped: a $ there is not a reference.
        i += 2;
        continue;
      }
      if (c === DQUOTE || c === LF) st = 'none';
    } else if (st === 'bq') {
      if (c === BACKTICK) st = 'none';
    } else if (c === LF) st = 'none';
    i++;
  }
  flush(raw.length);
  let bytes = new Uint8Array(0);
  if (build) {
    bytes = new Uint8Array(size);
    let o = 0;
    for (const p of parts) {
      bytes.set(p, o);
      o += p.length;
    }
  }
  return { size, missing, unrepresentable, bytes, segs };
}

const unhex = (b: number | undefined): number => {
  if (b === undefined) return -1;
  if (b >= 0x30 && b <= 0x39) return b - 0x30;
  if (b >= 0x61 && b <= 0x66) return b - 0x61 + 10;
  if (b >= 0x41 && b <= 0x46) return b - 0x41 + 10;
  return -1;
};

const SIMPLE_UNESCAPES: Readonly<Record<number, number>> = {
  0x61: 0x07, // a
  0x62: 0x08, // b
  0x66: 0x0c, // f
  0x6e: 0x0a, // n
  0x72: 0x0d, // r
  0x74: 0x09, // t
  0x76: 0x0b, // v
  0x5c: 0x5c, // \
  0x22: 0x22, // "
};

/**
 * Go's `strconv.Unquote` of the `"…"` string text[from, to) (quotes included), on bytes: the
 * value, or null for an invalid escape or a raw LF.
 */
function unquoteDQ(text: Uint8Array, from: number, to: number): Uint8Array | null {
  const out: number[] = [];
  for (let i = from + 1; i < to - 1;) {
    const c = text[i] ?? 0;
    if (c === LF) return null;
    if (c !== BACKSLASH) {
      out.push(c);
      i++;
      continue;
    }
    const e = text[i + 1];
    i += 2;
    if (e === undefined || i > to - 1) return null;
    const simple = SIMPLE_UNESCAPES[e];
    if (simple !== undefined) {
      out.push(simple);
      continue;
    }
    if (e === 0x78 || e === 0x75 || e === 0x55) {
      const n = e === 0x78 ? 2 : e === 0x75 ? 4 : 8;
      if (i + n > to - 1) return null;
      let v = 0;
      for (let k = 0; k < n; k++) {
        const d = unhex(text[i + k]);
        if (d < 0) return null;
        v = v * 16 + d;
      }
      i += n;
      if (e === 0x78) {
        out.push(v);
        continue;
      }
      if (v > 0x10ffff || (v >= 0xd800 && v <= 0xdfff)) return null;
      out.push(...encoder.encode(String.fromCodePoint(v)));
      continue;
    }
    if (e >= 0x30 && e <= 0x37) {
      if (i + 2 > to - 1) return null;
      let v = e - 0x30;
      for (let k = 0; k < 2; k++) {
        const d = (text[i + k] ?? 0) - 0x30;
        if (d < 0 || d > 7) return null;
        v = v * 8 + d;
      }
      if (v > 255) return null;
      i += 2;
      out.push(v);
      continue;
    }
    return null;
  }
  return Uint8Array.from(out);
}

/**
 * The string at text[i] (`"` or a backtick): its decoded value (null when it has none) and end,
 * by the rules of the Go reader's `readString`.
 */
function readString(text: Uint8Array, i: number): { value: Uint8Array | null; end: number } {
  if (text[i] === BACKTICK) {
    const j = text.indexOf(BACKTICK, i + 1);
    if (j < 0) return { value: null, end: text.length };
    return { value: text.subarray(i + 1, j).filter((b) => b !== CR), end: j + 1 };
  }
  for (let j = i + 1; j < text.length;) {
    const c = text[j];
    if (c === BACKSLASH) {
      j += 2;
      continue;
    }
    if (c === LF) return { value: null, end: j };
    if (c === DQUOTE) return { value: unquoteDQ(text, i, j + 1), end: j + 1 };
    j++;
  }
  return { value: null, end: text.length };
}

function skipComment(text: Uint8Array, i: number): number {
  const j = text.indexOf(LF, i);
  return j < 0 ? text.length : j;
}

const SOURCE = encoder.encode('source');
const PULSUS_DASH = encoder.encode('pulsus-dash');

const bytesEqual = (a: Uint8Array | null, b: Uint8Array): boolean =>
  a !== null && a.length === b.length && a.every((x, k) => x === b[k]);

/** An op at text[j]: `=~`, `!~`, `!=` or `=`, longest first; null when there is none. */
function readOp(text: Uint8Array, j: number): string | null {
  const c = text[j];
  const next = text[j + 1];
  if (c === 0x3d) return next === 0x7e ? '=~' : '=';
  if (c === 0x21 && next === 0x7e) return '!~';
  if (c === 0x21 && next === 0x3d) return '!=';
  return null;
}

/** The selector whose `{` is at text[i] (plan #116 §4.3), and its end. */
function readSelector(text: Uint8Array, i: number): { s: LogsSelector; end: number } {
  let reserved = false;
  let st: 0 | 1 | 2 = 0;
  let name: Uint8Array | null = null;
  let op = '';
  for (let j = i + 1; j < text.length;) {
    const c = text[j] ?? 0;
    if (c === 0x20 || c === 0x09 || c === CR || c === LF) {
      j++;
    } else if (c === HASH) {
      j = skipComment(text, j);
    } else if (c === BRACE_CLOSE) {
      return { s: { from: i, to: j + 1, reserved }, end: j + 1 };
    } else if (c === DQUOTE || c === BACKTICK) {
      const { value, end } = readString(text, j);
      j = end;
      if (st === 2) {
        if (bytesEqual(name, SOURCE) && op === '=' && bytesEqual(value, PULSUS_DASH))
          reserved = true;
        st = 0;
      } else {
        st = 1;
        name = value;
      }
    } else if (isNameStart(c)) {
      let k = j + 1;
      while (isNameByte(text[k])) k++;
      st = 1;
      name = text.subarray(j, k);
      j = k;
    } else {
      const o = readOp(text, j);
      if (o !== null) {
        if (st === 1) {
          st = 2;
          op = o;
        } else st = 0;
        j += o.length;
      } else {
        st = 0;
        j++;
      }
    }
  }
  return { s: { from: i, to: text.length, reserved }, end: text.length };
}

function classifyBytes(text: Uint8Array): LogsClass {
  const selectors: LogsSelector[] = [];
  for (let i = 0; i < text.length;) {
    const c = text[i];
    if (c === DQUOTE || c === BACKTICK) i = readString(text, i).end;
    else if (c === HASH) i = skipComment(text, i);
    else if (c === BRACE_OPEN) {
      const r = readSelector(text, i);
      selectors.push(r.s);
      i = r.end;
    } else i++;
  }
  const n = selectors.filter((s) => s.reserved).length;
  return {
    source: n === 0 ? 'pulsus_db' : n === selectors.length ? 'virtual' : 'mixed',
    reserved: n > 0 ? [RESERVED_MATCHER] : [],
    selectors,
  };
}

/** The Go `logs.Classify`: every stream selector outside strings and comments (§4.3). */
export function classifyLogs(text: string): LogsClass {
  return classifyBytes(encoder.encode(text));
}

const pointerToken = (s: string): string => s.replace(/~/g, '~0').replace(/\//g, '~1');

/** Row 9: the substituted text over the processing cap; no plan. */
const PROCESSING_CAP: LogsStubPlanError = {
  status: 413,
  message: 'the substituted query is over 2097152 bytes, the most the server processes',
  fields: [{ pointer: '/query', messageKey: 'query.too_large_to_plan' }],
  hint: { reason: 'processing_cap' },
};

function inputError(pointer: string, messageKey: string, message: string): LogsStubPlanError {
  return { status: 400, message, fields: [{ pointer, messageKey }] };
}

function namesError(
  names: readonly string[],
  messageKey: string,
  message: string,
): LogsStubPlanError {
  return {
    status: 400,
    message,
    fields: names.map((n) => ({ pointer: `/vars/${pointerToken(n)}`, messageKey })),
  };
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function byteOrder(a: string, b: string): number {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/** Rows 2–5 of plan #116 §3.1 (a JS string is always UTF-8 once encoded: row 1 cannot apply). */
function checkInputs(i: LogsPlanInputs, rawBytes: number): LogsStubPlanError | null {
  if (rawBytes === 0 || rawBytes > MAX_RAW_BYTES)
    return inputError('/query', 'field.range', 'query must be 1 to 131072 bytes');
  const names = Object.keys(i.vars);
  if (names.length > MAX_VARS)
    return inputError('/vars', 'field.range', 'vars must have at most 64 entries');
  for (const n of names.sort(byteOrder)) {
    if (!NAME.test(n))
      return inputError(
        `/vars/${pointerToken(n)}`,
        'field.pattern',
        'a variable name must match ^[A-Za-z_][A-Za-z0-9_]{0,63}$',
      );
    if (utf8Length(i.vars[n] ?? '') > MAX_VALUE_BYTES)
      return inputError(
        `/vars/${pointerToken(n)}`,
        'field.range',
        'a variable value must be UTF-8 and at most 4096 bytes',
      );
  }
  return null;
}

function concat(...ps: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(ps.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of ps) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Prepare: rows 1–5, 7, 7b and 9, the placeholder substitution and Classify (plan #116 §4.1). */
export function prepareLogs(i: LogsPlanInputs): LogsPrepared | LogsStubPlanError {
  const raw = encoder.encode(i.query);
  const bad = checkInputs(i, raw.length);
  if (bad !== null) return bad;
  const vars = new Map(Object.entries(i.vars).map(([k, v]) => [k, encoder.encode(v)] as const));
  const count = substitute(raw, vars, PLACEHOLDERS, false);
  if (count.missing.length > 0)
    return namesError(
      count.missing,
      'variable.missing',
      `no value for variable $${count.missing.join(', $')}`,
    );
  if (count.unrepresentable.length > 0)
    return namesError(
      count.unrepresentable,
      'variable.unrepresentable',
      `the value of variable $${count.unrepresentable.join(', $')} cannot be written where it is referenced`,
    );
  if (count.size > MAX_EXPANDED_BYTES) return PROCESSING_CAP;
  const sub = substitute(raw, vars, PLACEHOLDERS, true).bytes;
  const checkCap = (stepMs: number): LogsStubPlanError | null =>
    substitute(raw, vars, macrosAt(stepMs), false).size > MAX_EXPANDED_BYTES
      ? PROCESSING_CAP
      : null;
  return {
    substituted: decoder.decode(sub),
    class: classifyBytes(sub),
    checkCap,
    plan(stepMs) {
      if (stepMs <= 0) return inputError('/step_ms', 'field.range', 'step_ms must be positive');
      const cap = checkCap(stepMs);
      if (cap !== null) return cap;
      const e = substitute(raw, vars, macrosAt(stepMs), true);
      let query = e.bytes;
      let rw: Segment[] = [
        { sentFrom: 0, sentLen: e.size, rawFrom: 0, rawLen: e.size, kind: 'copy' },
      ];
      if (i.kind === 'volume') {
        const suffix = volumeSuffix(stepMs);
        query = concat(VOLUME_PREFIX, e.bytes, suffix);
        const p = VOLUME_PREFIX.length;
        rw = [
          { sentFrom: 0, sentLen: p, rawFrom: 0, rawLen: 0, kind: 'added' },
          { sentFrom: p, sentLen: e.size, rawFrom: 0, rawLen: e.size, kind: 'copy' },
          { sentFrom: p + e.size, sentLen: suffix.length, rawFrom: 0, rawLen: 0, kind: 'added' },
        ];
      }
      const planned: LogqlPlannedQuery = {
        query: decoder.decode(query),
        expanded: decoder.decode(e.bytes),
        bytes: query.length,
        stepMs,
      };
      if (query.length > MAX_SENT_BYTES) {
        return {
          status: 413,
          message: 'the planned query is over 65536 bytes',
          fields: [{ pointer: '/query', messageKey: 'query.sent_too_large' }],
          planned,
        };
      }
      const total = query.length;
      return {
        planned,
        class: classifyBytes(query),
        toSource: (sent) => {
          const x = at(rw, total, sent);
          return x === null ? null : at(e.segs, e.size, x);
        },
      };
    },
  };
}

/**
 * @internal Tests only: the steps of `prepareLogs` before row 9b (plan #121 §3.2), the text the
 * classify runner reads.
 */
export function substituteLogs(i: LogsPlanInputs): { substituted: string } | LogsStubPlanError {
  const p = prepareLogs(i);
  return isLogsPlanError(p) ? p : { substituted: p.substituted };
}
