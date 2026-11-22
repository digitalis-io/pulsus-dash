/**
 * The single decoder of query responses (ADR-0014 §5, T04-010): the BFF's JSON frames (plan #62
 * §3.4, T04 §0) into `SeriesFrame`s with `Float64Array` columns, NaN for an absent point. Every
 * field is validated; anything else is a `DecodeError` naming the JSON pointer of the first bad
 * element. Log pages (plan #65 Part B §3.5) decode into a columnar `LogFrame` with exact
 * `BigInt64Array` timestamps. Arrow arrives behind the same functions with the engine (#68).
 */
import type { ValueType } from '../editor/lang/types';
import { KEY_PATTERN, type ScalarFrame, type SeriesFrame } from './frames';
import { LOG_LEVELS, type LogFrame, type LogStreamInfo } from './logFrame';

export interface Completeness {
  readonly truncated: boolean;
  readonly warnings: readonly string[];
  readonly infos: readonly string[];
  readonly queryId: string | null;
  readonly dataAgeMs: number | null;
  readonly readCache: 'hit' | 'miss' | 'bypass' | 'other' | null;
  readonly readCacheThroughMs: number | null;
}

/** What the server planned and sent (plan #112 §3.8, OpenAPI `PlannedQuery`). */
export interface PlannedQuery {
  /** The text sent to PulsusDB. */
  readonly query: string;
  /** The substituted text before the rate rewrite. */
  readonly expanded: string;
  readonly bytes: number;
  readonly valueType: ValueType;
  readonly rateCandidate: boolean;
  readonly rateApplied: boolean;
  readonly histogram: boolean;
  readonly stepMs?: number;
  readonly rateWindowMs?: number;
}

export interface RangeResult {
  readonly planned: PlannedQuery;
  readonly startMs: number;
  readonly endMs: number;
  readonly stepMs: number;
  readonly series: readonly SeriesFrame[];
  readonly completeness: Completeness;
}

export type InstantResult = {
  readonly planned: PlannedQuery;
  readonly atMs: number;
  readonly completeness: Completeness;
} & (
  | {
      readonly kind: 'series';
      readonly resultType: 'vector' | 'matrix';
      readonly series: readonly SeriesFrame[];
    }
  | { readonly kind: 'scalar'; readonly scalar: ScalarFrame }
  | { readonly kind: 'string'; readonly value: string; readonly timestampMs: number }
);

export class DecodeError extends Error {
  /** JSON pointer of the first bad element, e.g. `/frames/0/values/3`. */
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.name = 'DecodeError';
    this.path = path;
  }
}

type Obj = Readonly<Record<string, unknown>>;

function isObject(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A JSON pointer reference token (RFC 6901). */
function token(s: string): string {
  return s.replace(/~/g, '~0').replace(/\//g, '~1');
}

function object(v: unknown, path: string): Obj {
  if (!isObject(v)) throw new DecodeError(path, 'expected an object');
  return v;
}

function array(v: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(v)) throw new DecodeError(path, 'expected an array');
  return v;
}

function integer(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) {
    throw new DecodeError(path, 'expected an integer');
  }
  return v;
}

function string(v: unknown, path: string): string {
  if (typeof v !== 'string') throw new DecodeError(path, 'expected a string');
  return v;
}

function strings(v: unknown, path: string): string[] {
  return array(v, path).map((x, i) => string(x, `${path}/${String(i)}`));
}

/** A frame value: a finite number is itself; `"NaN"`, `"+Inf"`, `"-Inf"`; `null` (absent) is NaN. */
export function decodeValue(v: unknown, path: string): number {
  if (v === null) return NaN;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (v === 'NaN') return NaN;
  if (v === '+Inf') return Infinity;
  if (v === '-Inf') return -Infinity;
  throw new DecodeError(path, 'expected a number, "NaN", "+Inf", "-Inf" or null');
}

function decodeFrame(v: unknown, path: string): SeriesFrame {
  const f = object(v, path);
  const key = string(f['key'], `${path}/key`);
  if (!KEY_PATTERN.test(key)) throw new DecodeError(`${path}/key`, 'expected 16 hex digits');
  const rawLabels = object(f['labels'], `${path}/labels`);
  const labels: Record<string, string> = {};
  for (const [k, x] of Object.entries(rawLabels)) {
    labels[k] = string(x, `${path}/labels/${token(k)}`);
  }
  const ts = array(f['timestamps'], `${path}/timestamps`);
  const timestamps = new Float64Array(ts.length);
  ts.forEach((t, i) => {
    const n = integer(t, `${path}/timestamps/${String(i)}`);
    if (i > 0 && !(n > (timestamps[i - 1] ?? NaN))) {
      throw new DecodeError(`${path}/timestamps/${String(i)}`, 'timestamps must increase');
    }
    timestamps[i] = n;
  });
  const vs = array(f['values'], `${path}/values`);
  if (vs.length !== ts.length) {
    throw new DecodeError(`${path}/values`, 'values and timestamps differ in length');
  }
  const values = new Float64Array(vs.length);
  vs.forEach((x, i) => {
    values[i] = decodeValue(x, `${path}/values/${String(i)}`);
  });
  return { key, labels, timestamps, values };
}

function frames(v: unknown, path: string): SeriesFrame[] {
  return array(v, path).map((f, i) => decodeFrame(f, `${path}/${String(i)}`));
}

const READ_CACHE = ['hit', 'miss', 'bypass', 'other'] as const;

function optional<T>(
  c: Obj,
  name: string,
  path: string,
  f: (v: unknown, p: string) => T,
): T | null {
  return c[name] === undefined ? null : f(c[name], `${path}/${name}`);
}

function nonNegative(v: unknown, path: string): number {
  const n = integer(v, path);
  if (n < 0) throw new DecodeError(path, 'expected a non-negative integer');
  return n;
}

function decodeCompleteness(v: unknown, path: string): Completeness {
  const c = object(v, path);
  if (typeof c['truncated'] !== 'boolean') {
    throw new DecodeError(`${path}/truncated`, 'expected a boolean');
  }
  return {
    truncated: c['truncated'],
    warnings: strings(c['warnings'], `${path}/warnings`),
    infos: strings(c['infos'], `${path}/infos`),
    queryId: optional(c, 'query_id', path, string),
    dataAgeMs: optional(c, 'data_age_ms', path, nonNegative),
    readCache: optional(c, 'read_cache', path, (x, p) => {
      const s = READ_CACHE.find((r) => r === x);
      if (s === undefined) throw new DecodeError(p, 'expected hit, miss, bypass or other');
      return s;
    }),
    readCacheThroughMs: optional(c, 'read_cache_through_ms', path, nonNegative),
  };
}

const VALUE_TYPES = ['scalar', 'string', 'vector', 'matrix', 'unknown'] as const;

function boolean(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') throw new DecodeError(path, 'expected a boolean');
  return v;
}

/** Decodes a `PlannedQuery` at `path` (plan #112 §3.8). */
export function decodePlanned(v: unknown, path: string): PlannedQuery {
  const p = object(v, path);
  const valueType = VALUE_TYPES.find((t) => t === p['value_type']);
  if (valueType === undefined) {
    throw new DecodeError(
      `${path}/value_type`,
      'expected scalar, string, vector, matrix or unknown',
    );
  }
  const stepMs = optional(p, 'step_ms', path, nonNegative);
  const rateWindowMs = optional(p, 'rate_window_ms', path, nonNegative);
  return {
    query: string(p['query'], `${path}/query`),
    expanded: string(p['expanded'], `${path}/expanded`),
    bytes: nonNegative(p['bytes'], `${path}/bytes`),
    valueType,
    rateCandidate: boolean(p['rate_candidate'], `${path}/rate_candidate`),
    rateApplied: boolean(p['rate_applied'], `${path}/rate_applied`),
    histogram: boolean(p['histogram'], `${path}/histogram`),
    ...(stepMs === null ? {} : { stepMs }),
    ...(rateWindowMs === null ? {} : { rateWindowMs }),
  };
}

/** Decodes a `PromRangeResponse` body. */
export function decodeRange(body: unknown): RangeResult {
  const b = object(body, '');
  return {
    planned: decodePlanned(b['planned'], '/planned'),
    startMs: integer(b['start'], '/start'),
    endMs: integer(b['end'], '/end'),
    stepMs: integer(b['step'], '/step'),
    series: frames(b['frames'], '/frames'),
    completeness: decodeCompleteness(b['completeness'], '/completeness'),
  };
}

const RESULT_TYPES = ['vector', 'matrix', 'scalar', 'string'] as const;

/** Decodes a `PromInstantResponse` body. */
export function decodeInstant(body: unknown): InstantResult {
  const b = object(body, '');
  const resultType = RESULT_TYPES.find((r) => r === b['result_type']);
  if (resultType === undefined) {
    throw new DecodeError('/result_type', 'expected vector, matrix, scalar or string');
  }
  const planned = decodePlanned(b['planned'], '/planned');
  const atMs = integer(b['at'], '/at');
  const series = frames(b['frames'], '/frames');
  const completeness = decodeCompleteness(b['completeness'], '/completeness');
  switch (resultType) {
    case 'vector':
    case 'matrix':
      return { kind: 'series', resultType, series, atMs, completeness, planned };
    case 'scalar': {
      const s = object(b['scalar'], '/scalar');
      const scalar = {
        value: decodeValue(s['value'], '/scalar/value'),
        timestampMs: integer(s['timestamp'], '/scalar/timestamp'),
      };
      return { kind: 'scalar', scalar, atMs, completeness, planned };
    }
    case 'string': {
      const s = object(b['string'], '/string');
      return {
        kind: 'string',
        value: string(s['value'], '/string/value'),
        timestampMs: integer(s['timestamp'], '/string/timestamp'),
        atMs,
        completeness,
        planned,
      };
    }
  }
}

/** A LogQL range result: a log page, or the frames of a LogQL metric query on the grid. */
export type LogsResult =
  | {
      readonly kind: 'streams';
      /** The request's window `(fromMs, toMs]`. */
      readonly fromMs: number;
      readonly toMs: number;
      /** The grid step. */
      readonly stepMs: number;
      readonly frame: LogFrame;
      /** The next page's cursor; null when no entry of the window is left. */
      readonly cursor: string | null;
      readonly completeness: Completeness;
    }
  | ({ readonly kind: 'series' } & RangeResult);

const DIRECTIONS = ['backward', 'forward'] as const;
const TS_PATTERN = /^(0|[1-9][0-9]{0,18})$/;
const MAX_INT64 = 9223372036854775807n;
const NS_PER_MS = 1000000n;

function stringMap(v: unknown, path: string): Record<string, string> {
  const o = object(v, path);
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(o)) out[k] = string(x, `${path}/${token(k)}`);
  return out;
}

function optionalMap(e: Obj, name: string, path: string): Record<string, string> | null {
  return e[name] === undefined ? null : stringMap(e[name], `${path}/${name}`);
}

interface DecodedStream {
  readonly ts: bigint[];
  readonly lines: string[];
  readonly levels: number[];
  readonly metadata: (Record<string, string> | null)[];
  readonly parsed: (Record<string, string> | null)[];
}

/** Decodes a `LogqlRangeResponse` body (a log page or a metric result). */
export function decodeLogs(body: unknown): LogsResult {
  const b = object(body, '');
  if (b['kind'] === 'series') return { kind: 'series', ...decodeRange(b) };
  if (b['kind'] !== 'streams') throw new DecodeError('/kind', 'expected streams or series');
  const direction = DIRECTIONS.find((d) => d === b['direction']);
  const fromMs = integer(b['start'], '/start');
  const toMs = integer(b['end'], '/end');
  const stepMs = integer(b['step'], '/step');
  if (direction === undefined) throw new DecodeError('/direction', 'expected backward or forward');
  const lo = BigInt(fromMs) * NS_PER_MS;
  const hi = BigInt(toMs) * NS_PER_MS;
  const backward = direction === 'backward';
  const streams: LogStreamInfo[] = [];
  const decoded: DecodedStream[] = [];
  array(b['streams'], '/streams').forEach((v, si) => {
    const path = `/streams/${String(si)}`;
    const s = object(v, path);
    const key = string(s['key'], `${path}/key`);
    if (!KEY_PATTERN.test(key)) throw new DecodeError(`${path}/key`, 'expected 16 hex digits');
    streams.push({ key, labels: stringMap(s['labels'], `${path}/labels`) });
    const d: DecodedStream = { ts: [], lines: [], levels: [], metadata: [], parsed: [] };
    array(s['entries'], `${path}/entries`).forEach((x, ei) => {
      const ep = `${path}/entries/${String(ei)}`;
      const e = object(x, ep);
      const text = e['ts_ns'];
      if (typeof text !== 'string' || !TS_PATTERN.test(text)) {
        throw new DecodeError(`${ep}/ts_ns`, 'expected a decimal ns timestamp');
      }
      const ts = BigInt(text);
      if (ts > MAX_INT64 || ts <= lo || ts > hi) {
        throw new DecodeError(`${ep}/ts_ns`, 'timestamp outside the window (start, end]');
      }
      const prev = d.ts[d.ts.length - 1];
      if (prev !== undefined && (backward ? ts > prev : ts < prev)) {
        throw new DecodeError(`${ep}/ts_ns`, `entries must be in ${direction} order`);
      }
      const line = string(e['line'], `${ep}/line`);
      const level = LOG_LEVELS.indexOf(e['level'] as never);
      if (level < 0) throw new DecodeError(`${ep}/level`, 'expected a log level');
      d.ts.push(ts);
      d.lines.push(line);
      d.levels.push(level);
      d.metadata.push(optionalMap(e, 'metadata', ep));
      d.parsed.push(optionalMap(e, 'parsed', ep));
    });
    decoded.push(d);
  });
  const cursor = b['cursor'] === undefined ? null : string(b['cursor'], '/cursor');
  if (cursor === '') throw new DecodeError('/cursor', 'expected a non-empty string');
  const completeness = decodeCompleteness(b['completeness'], '/completeness');
  return {
    kind: 'streams',
    fromMs,
    toMs,
    stepMs,
    frame: merge(direction, streams, decoded),
    cursor,
    completeness,
  };
}

/**
 * The k-way merge of the streams into rows: by ts in direction, then stream index ascending,
 * then entry index. Streams arrive in key order and the BFF orders each timestamp group by
 * (stream key, line), so this reproduces the BFF's page order. Each stream is already in
 * direction order, so a stable sort by ts of the rows laid out stream by stream is that merge.
 */
function merge(
  direction: 'backward' | 'forward',
  streams: readonly LogStreamInfo[],
  decoded: readonly DecodedStream[],
): LogFrame {
  const src: { ts: bigint; s: number; i: number }[] = [];
  decoded.forEach((d, s) => {
    d.ts.forEach((ts, i) => src.push({ ts, s, i }));
  });
  const sign = direction === 'backward' ? -1 : 1;
  src.sort((a, b) => (a.ts === b.ts ? 0 : a.ts < b.ts ? -sign : sign)); // stable (ES2019)
  const n = src.length;
  const tsNs = new BigInt64Array(n);
  const streamIndex = new Uint32Array(n);
  const levels = new Uint8Array(n);
  const lines: string[] = [];
  const metadata: (Record<string, string> | null)[] = [];
  const parsed: (Record<string, string> | null)[] = [];
  src.forEach((r, row) => {
    const d = decoded[r.s];
    tsNs[row] = r.ts;
    streamIndex[row] = r.s;
    levels[row] = d?.levels[r.i] ?? 0;
    lines.push(d?.lines[r.i] ?? '');
    metadata.push(d?.metadata[r.i] ?? null);
    parsed.push(d?.parsed[r.i] ?? null);
  });
  return { direction, streams, tsNs, streamIndex, lines, levels, metadata, parsed };
}

/** Decodes a log volume body: a `PromRangeResponse` whose frames are labelled exactly `{level}`. */
export function decodeVolume(body: unknown): RangeResult {
  const r = decodeRange(body);
  r.series.forEach((s, i) => {
    const names = Object.keys(s.labels);
    const level = s.labels['level'];
    if (names.length !== 1 || level === undefined || !LOG_LEVELS.includes(level as never)) {
      throw new DecodeError(`/frames/${String(i)}/labels`, 'expected exactly {level: <log level>}');
    }
  });
  return r;
}

export interface PromValues {
  readonly values: readonly string[];
  readonly completeness: Completeness;
}

export interface PromSeriesSet {
  readonly series: readonly {
    readonly key: string;
    readonly labels: Readonly<Record<string, string>>;
  }[];
  readonly completeness: Completeness;
}

export interface PromMetricMetadata {
  readonly type: string;
  readonly help: string;
  readonly unit: string;
}

export interface PromMetadata {
  readonly metrics: Readonly<Record<string, readonly PromMetricMetadata[]>>;
  readonly completeness: Completeness;
}

/** Decodes a `PromValuesResponse` body (label names or values). */
export function decodeValues(body: unknown): PromValues {
  const b = object(body, '');
  return {
    values: strings(b['values'], '/values'),
    completeness: decodeCompleteness(b['completeness'], '/completeness'),
  };
}

/** A JSON object of strings; `Object.fromEntries` keeps every name an own property. */
function labelSet(v: unknown, path: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(object(v, path)).map(([k, x]) => [k, string(x, `${path}/${token(k)}`)]),
  );
}

/** Decodes a `PromSeriesResponse` body; every key matches `KEY_PATTERN`. */
export function decodeSeriesSet(body: unknown): PromSeriesSet {
  const b = object(body, '');
  const series = array(b['series'], '/series').map((v, i) => {
    const path = `/series/${String(i)}`;
    const s = object(v, path);
    const key = string(s['key'], `${path}/key`);
    if (!KEY_PATTERN.test(key)) throw new DecodeError(`${path}/key`, 'expected 16 hex digits');
    return { key, labels: labelSet(s['labels'], `${path}/labels`) };
  });
  return { series, completeness: decodeCompleteness(b['completeness'], '/completeness') };
}

/** Decodes a `PromMetadataResponse` body. */
export function decodeMetadata(body: unknown): PromMetadata {
  const b = object(body, '');
  const metrics = Object.fromEntries(
    Object.entries(object(b['metrics'], '/metrics')).map(([name, entries]) => {
      const path = `/metrics/${token(name)}`;
      const list = array(entries, path).map((e, i): PromMetricMetadata => {
        const p = `${path}/${String(i)}`;
        const m = object(e, p);
        return {
          type: string(m['type'], `${p}/type`),
          help: string(m['help'], `${p}/help`),
          unit: string(m['unit'], `${p}/unit`),
        };
      });
      return [name, list];
    }),
  );
  return { metrics, completeness: decodeCompleteness(b['completeness'], '/completeness') };
}
