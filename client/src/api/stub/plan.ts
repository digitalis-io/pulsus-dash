/**
 * The StubApi planner mirror (plan #112 §3.7, ADR-0021 §4): the rules of the server's `prom.Plan`
 * for `npm run dev` and the tests, run against the shared fixture `wire/fixtures/plan/promql.json`
 * by `plan.test.ts` as the Go planner is. Only `StubApi` imports it (an ESLint rule forbids other
 * importers): in http mode the server plans and the client reads `planned`.
 *
 * The raw text is encoded once and planned on its UTF-8 bytes, as Go does: offsets, sizes and the
 * position map are in bytes.
 */
import type { PlannedQuery, PromMetadata } from '../../data/decode';
import type { QueryShape, ValueType } from '../../editor/lang/types';
import { kindOfType, metricKind, type MetricKind } from '../../explore/metricKind';
import type { FieldError } from '../types';

export const MAX_RAW_BYTES = 131_072,
  MAX_SENT_BYTES = 65_536,
  MAX_VARS = 64,
  MAX_VALUE_BYTES = 4_096;
/** The processing cap (the request-body limit, T06-021). */
const MAX_EXPANDED_BYTES = 2 * 1024 * 1024;
/** The scrape interval of the rate window until a per-binding one exists. */
const DEFAULT_SCRAPE_MS = 15_000;
const MAX_NAME_LEN = 64;

/** The Go constant `prom.WarnTypesUnavailable`, byte for byte. */
export const WARN_TYPES_UNAVAILABLE =
  'pulsus-dash: metric types unavailable, so only names ending in _total are rated (metric_types_unavailable)';

export interface PlanInputs {
  readonly query: string;
  readonly vars: Readonly<Record<string, string>>;
  readonly kind: 'range' | 'instant';
  readonly stepMs: number;
  readonly rate: boolean;
}

export type MetricTypes = Readonly<Record<string, MetricKind>>;

/** A shape in UTF-8 byte offsets. */
export interface ByteShape {
  readonly bare: { readonly metric: string; readonly from: number; readonly to: number } | null;
  readonly metrics: readonly string[];
  readonly hasHistogramQuantile: boolean;
  readonly valueType: ValueType;
}

export interface StubPlanned {
  readonly planned: PlannedQuery;
  toSource(sentByte: number): number | null;
}

/** A refusal, as the gateway's `planError` writes it (A.11). */
export interface StubPlanError {
  readonly status: 400 | 413;
  readonly message: string;
  readonly fields: readonly FieldError[];
  readonly hint?: { readonly reason: 'processing_cap' };
  readonly planned?: PlannedQuery;
}

export interface StubClass {
  readonly source: 'pulsus_db' | 'virtual' | 'mixed';
  readonly reserved: readonly string[];
  readonly floorMs: number;
}

export interface Prepared {
  /** The placeholder text: the byte guard and Classify read it, nothing sends it. */
  readonly substituted: string;
  needsTypes(s: ByteShape): boolean;
  classify(s: ByteShape): StubClass;
  /** The text with the macros at `stepMs`, before the rate rewrite. */
  expandedAt(stepMs: number): string | StubPlanError;
  plan(stepMs: number, s: ByteShape, t: MetricTypes): StubPlanned | StubPlanError;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** UTF-8 bytes of `s`; a lone surrogate counts 3 (as `TextEncoder`'s U+FFFD). */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        n += 4;
        i += 1;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

// The byte guard (pulsusdb.reservedIn, T07-020 v1): a reserved metric name as a whole word, or the
// exact bytes source="pulsus-dash"; strings included.
const RESERVED_NAMES = ['ALERTS_FOR_STATE', 'ALERTS', 'pulsus_anomaly_score'] as const;
const RESERVED_SOURCE = 'source="pulsus-dash"';
const RESERVED_FLOORS: Readonly<Record<string, number>> = {
  ALERTS: 15_000,
  ALERTS_FOR_STATE: 15_000,
  pulsus_anomaly_score: 300_000,
};

const wordChar = (c: string | undefined): boolean => c !== undefined && /^[A-Za-z0-9_:]$/.test(c);

function wholeWord(s: string, w: string): boolean {
  for (let i = s.indexOf(w); i >= 0; i = s.indexOf(w, i + 1)) {
    if (!wordChar(s[i - 1]) && !wordChar(s[i + w.length])) return true;
  }
  return false;
}

/** The server's byte guard (`pulsusdb.reservedIn`), byte for byte. */
export function reservedIn(text: string): string | null {
  for (const n of RESERVED_NAMES) if (wholeWord(text, n)) return n;
  return text.includes(RESERVED_SOURCE) ? RESERVED_SOURCE : null;
}

/** `stepMs` when `floorMs ≤ 0`, else the least multiple of `floorMs` at least `stepMs` (T07 §4.3). */
export function floorStep(stepMs: number, floorMs: number): number {
  if (floorMs <= 0 || stepMs <= 0) return stepMs;
  return Math.ceil(stepMs / floorMs) * floorMs;
}

/** `max(4 × step, step + S, 4 × S)`, S the default scrape interval (15 s). */
export function rateWindowMs(stepMs: number): number {
  return Math.max(4 * stepMs, stepMs + DEFAULT_SCRAPE_MS, 4 * DEFAULT_SCRAPE_MS);
}

const DURATION_UNITS = [
  ['d', 86_400_000],
  ['h', 3_600_000],
  ['m', 60_000],
  ['s', 1_000],
] as const;

/** The largest of d, h, m, s that divides `ms` (> 0), else `<ms>ms`. */
export function formatDuration(ms: number): string {
  for (const [unit, size] of DURATION_UNITS) {
    if (ms > 0 && ms % size === 0) return `${String(ms / size)}${unit}`;
  }
  return `${String(ms)}ms`;
}

export function kindOf(name: string, t: MetricTypes): MetricKind {
  return metricKind(name, (n) => (Object.hasOwn(t, n) ? kindOfType(t[n]) : null));
}

/** Each name's first entry; a type not one of the kinds is unknown; no entry is absent. */
export function typesFromMetadata(m: PromMetadata['metrics']): MetricTypes {
  const out: Record<string, MetricKind> = {};
  for (const [name, list] of Object.entries(m)) {
    const k = kindOfType(list[0]?.type);
    if (k !== null) out[name] = k;
  }
  return out;
}

/** A Lezer shape (UTF-16 offsets) in UTF-8 byte offsets. */
export function byteShape(text: string, s: QueryShape): ByteShape {
  const b = s.bareSelector;
  return {
    bare:
      b === null
        ? null
        : {
            metric: b.metric,
            from: utf8Length(text.slice(0, b.from)),
            to: utf8Length(text.slice(0, b.to)),
          },
    metrics: s.metrics,
    hasHistogramQuantile: s.hasHistogramQuantile,
    valueType: s.valueType,
  };
}

export function isPlanError(x: unknown): x is StubPlanError {
  return typeof x === 'object' && x !== null && 'status' in x && 'message' in x;
}

// The segment map (plan #112 §4.2).
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

/** The lexical state of the substitution scan (plan #118 §4.1). */
type LexState = 'none' | 'dq' | 'sq' | 'bq' | 'comment';

interface Substitution {
  readonly size: number;
  /** Row 7: distinct, first-reference order. */
  readonly missing: readonly string[];
  /** Row 7b: distinct, first-reference order. */
  readonly unrepresentable: readonly string[];
  readonly macro: boolean;
  readonly bytes: Uint8Array;
  readonly segs: readonly Segment[];
}

const DOLLAR = 0x24,
  BRACE_OPEN = 0x7b,
  BRACE_CLOSE = 0x7d,
  BACKSLASH = 0x5c,
  DQUOTE = 0x22,
  SQUOTE = 0x27,
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

const HEX = encoder.encode('0123456789abcdef');
/** U+FFFD as UTF-8: the upstream lexer refuses it in a string (plan #118 §3.1). */
const FFFD = [0xef, 0xbf, 0xbd] as const;
const ESCAPED_FFFD = encoder.encode('\\ufffd');

const isFffdAt = (v: Uint8Array, i: number): boolean =>
  v[i] === FFFD[0] && v[i + 1] === FFFD[1] && v[i + 2] === FFFD[2];

/** The letter of the one-letter escape of byte `b` (`\a` … `\v`, `\\`), or 0. */
function escapeLetter(b: number): number {
  switch (b) {
    case BACKSLASH:
      return BACKSLASH;
    case 0x07:
      return 0x61; // a
    case 0x08:
      return 0x62; // b
    case 0x0c:
      return 0x66; // f
    case LF:
      return 0x6e; // n
    case CR:
      return 0x72; // r
    case 0x09:
      return 0x74; // t
    case 0x0b:
      return 0x76; // v
  }
  return 0;
}

/** The length of byte `b` written in a string opened by `quote`: 1, 2 or 4 (`\xHH`). */
function escapedByteLen(b: number, quote: number): number {
  if (b === quote || escapeLetter(b) !== 0) return 2;
  return b < 0x20 || b === 0x7f ? 4 : 1;
}

/** `encodeQuoted(v, quote).length` without building it or allocating. */
function quotedLen(v: Uint8Array, quote: number): number {
  let n = 0;
  for (let i = 0; i < v.length;) {
    if (isFffdAt(v, i)) {
      n += ESCAPED_FFFD.length;
      i += FFFD.length;
      continue;
    }
    n += escapedByteLen(v[i] ?? 0, quote);
    i++;
  }
  return n;
}

/**
 * Plan #118 §4.2 on bytes; `quote` is DQUOTE or SQUOTE. Only the opening quote is escaped, U+FFFD
 * is written `\ufffd` and any other non-ASCII rune as itself. Returns `v` itself when nothing is
 * escaped; otherwise one array of `quotedLen(v, quote)` bytes.
 */
function encodeQuoted(v: Uint8Array, quote: number): Uint8Array {
  const n = quotedLen(v, quote);
  if (n === v.length) return v;
  const out = new Uint8Array(n);
  let o = 0;
  for (let i = 0; i < v.length;) {
    if (isFffdAt(v, i)) {
      out.set(ESCAPED_FFFD, o);
      o += ESCAPED_FFFD.length;
      i += FFFD.length;
      continue;
    }
    const b = v[i] ?? 0;
    i++;
    const letter = b === quote ? quote : escapeLetter(b);
    if (letter !== 0) {
      out[o++] = BACKSLASH;
      out[o++] = letter;
    } else if (b < 0x20 || b === 0x7f) {
      out[o++] = BACKSLASH;
      out[o++] = 0x78; // x
      out[o++] = HEX[b >> 4] ?? 0;
      out[o++] = HEX[b & 0xf] ?? 0;
    } else out[o++] = b;
  }
  return out;
}

/**
 * Test hook (review r2): the number of `quotedLen` and `representable` computations of the scans,
 * so the memo is tested by count rather than by time. Read and reset by `plan.test.ts` only.
 */
export const __test = { valueReads: 0 };

/**
 * Per-scan memo of what a value costs where it is referenced: its length in `"…"` and `'…'`,
 * whether it is representable in each state, and (building) its encoded bytes. A scan repeats a
 * reference many times, so each value is read once per state (review r1).
 */
class ValueMemo {
  private readonly lens = new Map<Uint8Array, number>();
  private readonly lensSq = new Map<Uint8Array, number>();
  private readonly enc = new Map<Uint8Array, Uint8Array>();
  private readonly encSq = new Map<Uint8Array, Uint8Array>();
  private readonly rep = new Map<Uint8Array, Map<LexState, boolean>>();

  len(v: Uint8Array, st: LexState): number {
    if (st !== 'dq' && st !== 'sq') return v.length;
    const m = st === 'dq' ? this.lens : this.lensSq;
    let n = m.get(v);
    if (n === undefined) {
      __test.valueReads++;
      n = quotedLen(v, st === 'dq' ? DQUOTE : SQUOTE);
      m.set(v, n);
    }
    return n;
  }

  bytes(v: Uint8Array, st: LexState): Uint8Array {
    if (st !== 'dq' && st !== 'sq') return v;
    const m = st === 'dq' ? this.enc : this.encSq;
    let e = m.get(v);
    if (e === undefined) {
      e = encodeQuoted(v, st === 'dq' ? DQUOTE : SQUOTE);
      m.set(v, e);
    }
    return e;
  }

  representable(v: Uint8Array, st: LexState): boolean {
    // "…", '…' and the top level take any value: nothing to compute.
    if (st !== 'bq' && st !== 'comment') return true;
    let m = this.rep.get(v);
    if (m === undefined) {
      m = new Map();
      this.rep.set(v, m);
    }
    let r = m.get(st);
    if (r === undefined) {
      __test.valueReads++;
      r = representable(v, st);
      m.set(st, r);
    }
    return r;
  }
}

function holdsFffd(v: Uint8Array): boolean {
  for (let i = 0; i < v.length; i++) if (isFffdAt(v, i)) return true;
  return false;
}

/**
 * Row 7b (plan #118 §4.3): in `…` a backtick, a CR or U+FFFD cannot be written; in a comment an
 * LF or a CR cannot. Quoted strings take any value (encoded); the top level takes it as text.
 */
function representable(v: Uint8Array, st: LexState): boolean {
  switch (st) {
    case 'bq':
      return !v.includes(BACKTICK) && !v.includes(CR) && !holdsFffd(v);
    case 'comment':
      return !v.includes(LF) && !v.includes(CR);
    default:
      return true;
  }
}

/** The state after byte `c` in state `st`, the `\` skip aside (plan #118 §4.1). */
function nextState(st: LexState, c: number): LexState {
  switch (st) {
    case 'none':
      if (c === DQUOTE) return 'dq';
      if (c === SQUOTE) return 'sq';
      if (c === BACKTICK) return 'bq';
      return c === HASH ? 'comment' : 'none';
    case 'dq':
      return c === DQUOTE || c === LF ? 'none' : st;
    case 'sq':
      return c === SQUOTE || c === LF ? 'none' : st;
    case 'bq':
      return c === BACKTICK ? 'none' : st;
    case 'comment':
      return c === LF || c === CR ? 'none' : st;
  }
}

/**
 * `text` with every CR that ends a `#` comment (by the states of plan #118 §4.1, on the text
 * itself) replaced by LF; every other byte unchanged, so offsets are kept. Lezer's LineComment
 * runs to LF only; the upstream lexer's runs to LF or CR.
 */
export function endCommentsAtCR(text: string): string {
  if (!text.includes('\r')) return text;
  let out = '';
  let from = 0;
  let st: LexState = 'none';
  // The states read ASCII bytes only, so UTF-16 units give the same states as UTF-8 bytes.
  for (let i = 0; i < text.length;) {
    const c = text.charCodeAt(i);
    if ((st === 'dq' || st === 'sq') && c === BACKSLASH) {
      i += 2;
      continue;
    }
    if (st === 'comment' && c === CR) {
      out += text.slice(from, i) + '\n';
      from = i + 1;
    }
    st = nextState(st, c);
    i++;
  }
  return out + text.slice(from);
}

/** One scan of the raw bytes (plan #112 §4.2); `build` false only counts the output. */
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
  const memo = new ValueMemo();
  let size = 0;
  let macro = false;
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
      if (ref.name === '__interval') {
        value = m.interval;
        macro = true;
      } else if (ref.name === '__rate_interval') {
        value = m.rateInterval;
        macro = true;
      } else if (!ref.name.startsWith('__') && ref.name.length <= MAX_NAME_LEN) {
        value = vars.get(ref.name) ?? null;
        isVar = value !== null;
        if (value === null && !missing.includes(ref.name)) missing.push(ref.name);
      }
      if (value === null) {
        i = ref.end;
        continue;
      }
      // A macro's text is a duration: only a value is checked (row 7b).
      if (isVar && !memo.representable(value, st) && !unrepresentable.includes(ref.name))
        unrepresentable.push(ref.name);
      flush(i);
      // Counting only measures the value: nothing is built before the cap is checked.
      const n = memo.len(value, st);
      if (build) {
        segs.push({
          sentFrom: size,
          sentLen: n,
          rawFrom: i,
          rawLen: ref.end - i,
          kind: 'insert',
        });
        parts.push(memo.bytes(value, st));
      }
      size += n;
      i = ref.end;
      copyFrom = ref.end;
      continue;
    }
    if ((st === 'dq' || st === 'sq') && c === BACKSLASH) {
      // The escaped byte is skipped: a $ there is not a reference.
      i += 2;
      continue;
    }
    st = nextState(st, c ?? 0);
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
  return { size, missing, unrepresentable, macro, bytes, segs };
}

const pointerToken = (s: string): string => s.replace(/~/g, '~0').replace(/\//g, '~1');

/** Row 9: the substituted text over the processing cap; no plan. */
const PROCESSING_CAP: StubPlanError = {
  status: 413,
  message: 'the substituted query is over 2097152 bytes, the most the server processes',
  fields: [{ pointer: '/query', messageKey: 'query.too_large_to_plan' }],
  hint: { reason: 'processing_cap' },
};

function inputError(pointer: string, messageKey: string, message: string): StubPlanError {
  return { status: 400, message, fields: [{ pointer, messageKey }] };
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

/** Rows 2–5 of §3.1 (a JS string is always UTF-8 once encoded: row 1 cannot apply). */
function checkInputs(i: PlanInputs, rawBytes: number): StubPlanError | null {
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

function classifyShape(s: ByteShape): StubClass {
  const reserved = s.metrics.filter((m) => Object.hasOwn(RESERVED_FLOORS, m));
  const floorMs = Math.max(0, ...reserved.map((m) => RESERVED_FLOORS[m] ?? 0));
  const source =
    reserved.length === 0
      ? 'pulsus_db'
      : reserved.length === s.metrics.length
        ? 'virtual'
        : 'mixed';
  return { source, reserved, floorMs };
}

const isCounter = (n: string, t: MetricTypes): boolean =>
  n.endsWith('_total') || kindOf(n, t) === 'counter';

function isHistogram(n: string, t: MetricTypes): boolean {
  if (!n.endsWith('_bucket')) return false;
  const k = kindOf(n, t);
  return k === 'histogram' || k === 'unknown';
}

/** Prepare: rows 1–5, 7, 7b (plan #118 §4.3), 8 and 9 of §3.1, the placeholder substitution (plan #112 §4.1). */
export function prepare(i: PlanInputs): Prepared | StubPlanError {
  const raw = encoder.encode(i.query);
  const bad = checkInputs(i, raw.length);
  if (bad !== null) return bad;
  const vars = new Map(Object.entries(i.vars).map(([k, v]) => [k, encoder.encode(v)] as const));
  const count = substitute(raw, vars, PLACEHOLDERS, false);
  if (count.missing.length > 0) {
    return {
      status: 400,
      message: `no value for variable $${count.missing.join(', $')}`,
      fields: count.missing.map((n) => ({
        pointer: `/vars/${pointerToken(n)}`,
        messageKey: 'variable.missing',
      })),
    };
  }
  if (count.unrepresentable.length > 0) {
    return {
      status: 400,
      message: `the value of variable $${count.unrepresentable.join(', $')} cannot be written where it is referenced`,
      fields: count.unrepresentable.map((n) => ({
        pointer: `/vars/${pointerToken(n)}`,
        messageKey: 'variable.unrepresentable',
      })),
    };
  }
  if (count.macro && i.stepMs === 0)
    return inputError(
      '/step_ms',
      'field.required',
      'step_ms is required for $__interval and $__rate_interval',
    );
  if (count.size > MAX_EXPANDED_BYTES) return PROCESSING_CAP;
  const substituted = decoder.decode(substitute(raw, vars, PLACEHOLDERS, true).bytes);
  const expanded = new Map<number, Substitution | StubPlanError>();
  // Row 9 again at the resolved step: a macro's text may be longer than the placeholder, so the
  // length is counted before the text is built.
  const sub = (stepMs: number): Substitution | StubPlanError => {
    let s = expanded.get(stepMs);
    if (s === undefined) {
      const m = macrosAt(stepMs);
      s =
        substitute(raw, vars, m, false).size > MAX_EXPANDED_BYTES
          ? PROCESSING_CAP
          : substitute(raw, vars, m, true);
      expanded.set(stepMs, s);
    }
    return s;
  };
  return {
    substituted,
    needsTypes(s) {
      if (s.bare !== null) return !s.bare.metric.endsWith('_total');
      return !s.hasHistogramQuantile && s.metrics.some((m) => m.endsWith('_bucket'));
    },
    classify: classifyShape,
    expandedAt: (stepMs) => {
      const e = sub(stepMs);
      return isPlanError(e) ? e : decoder.decode(e.bytes);
    },
    plan(stepMs, s, types) {
      if ((i.kind === 'range' && stepMs <= 0) || stepMs < 0)
        return inputError('/step_ms', 'field.range', 'step_ms must be positive');
      const e = sub(stepMs);
      if (isPlanError(e)) return e;
      const expandedText = decoder.decode(e.bytes);
      interface Facts {
        readonly query: string;
        readonly rw: readonly Segment[];
        readonly rateCandidate: boolean;
        readonly rateApplied: boolean;
        readonly histogram: boolean;
      }
      const asIs: Facts = {
        query: expandedText,
        rw: [{ sentFrom: 0, sentLen: e.size, rawFrom: 0, rawLen: e.size, kind: 'copy' }],
        rateCandidate: false,
        rateApplied: false,
        histogram: false,
      };
      const rated = stepMs > 0 && i.rate;
      const bare = s.bare;
      const w = (): string => formatDuration(rateWindowMs(stepMs));
      // A wrap sends the selector's exact bytes; the bytes of `expanded` outside it are dropped.
      const wrap = (
        b: NonNullable<ByteShape['bare']>,
        prefix: string,
        suffix: string,
        histogram: boolean,
      ): Facts => {
        const span = e.bytes.subarray(b.from, b.to);
        return {
          query: prefix + decoder.decode(span) + suffix,
          rw: [
            { sentFrom: 0, sentLen: prefix.length, rawFrom: 0, rawLen: 0, kind: 'added' },
            {
              sentFrom: prefix.length,
              sentLen: span.length,
              rawFrom: b.from,
              rawLen: span.length,
              kind: 'copy',
            },
            {
              sentFrom: prefix.length + span.length,
              sentLen: suffix.length,
              rawFrom: 0,
              rawLen: 0,
              kind: 'added',
            },
          ],
          rateCandidate: true,
          rateApplied: true,
          histogram,
        };
      };
      let f: Facts;
      if (bare !== null && isHistogram(bare.metric, types)) {
        f = rated
          ? wrap(bare, 'sum by (le) (rate(', `[${w()}]))`, true)
          : { ...asIs, rateCandidate: true };
      } else if (bare !== null && isCounter(bare.metric, types)) {
        f = rated ? wrap(bare, 'rate(', `[${w()}])`, false) : { ...asIs, rateCandidate: true };
      } else {
        const histogram = !s.hasHistogramQuantile && s.metrics.some((m) => isHistogram(m, types));
        f = { ...asIs, histogram };
      }
      const { query, rateCandidate, rateApplied, histogram } = f;
      const bytes = utf8Length(query);
      const planned: PlannedQuery = {
        query,
        expanded: expandedText,
        bytes,
        valueType: s.valueType,
        rateCandidate,
        rateApplied,
        histogram,
        ...(stepMs > 0 ? { stepMs } : {}),
        ...(rateApplied ? { rateWindowMs: rateWindowMs(stepMs) } : {}),
      };
      if (bytes > MAX_SENT_BYTES) {
        return {
          status: 413,
          message: 'the planned query is over 65536 bytes',
          fields: [{ pointer: '/query', messageKey: 'query.sent_too_large' }],
          planned,
        };
      }
      const map = f.rw;
      return {
        planned,
        toSource: (sent) => {
          const x = at(map, bytes, sent);
          return x === null ? null : at(e.segs, e.size, x);
        },
      };
    },
  };
}
