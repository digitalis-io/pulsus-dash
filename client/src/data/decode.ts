/**
 * The single decoder of query responses (ADR-0014 §5, T04-010): the BFF's JSON frames (plan #62
 * §3.4, T04 §0) into `SeriesFrame`s with `Float64Array` columns, NaN for an absent point. Every
 * field is validated; anything else is a `DecodeError` naming the JSON pointer of the first bad
 * element. Arrow arrives behind the same functions with the engine (#68).
 */
import { KEY_PATTERN, type ScalarFrame, type SeriesFrame } from './frames';
import type { LogFrame } from './logFrame';

export interface Completeness {
  readonly truncated: boolean;
  readonly warnings: readonly string[];
  readonly infos: readonly string[];
  readonly queryId: string | null;
  readonly dataAgeMs: number | null;
  readonly readCache: 'hit' | 'miss' | 'bypass' | 'other' | null;
  readonly readCacheThroughMs: number | null;
}

export interface RangeResult {
  readonly startMs: number;
  readonly endMs: number;
  readonly stepMs: number;
  readonly series: readonly SeriesFrame[];
  readonly completeness: Completeness;
}

export type InstantResult = { readonly atMs: number; readonly completeness: Completeness } & (
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

/** Decodes a `PromRangeResponse` body. */
export function decodeRange(body: unknown): RangeResult {
  const b = object(body, '');
  return {
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
  const atMs = integer(b['at'], '/at');
  const series = frames(b['frames'], '/frames');
  const completeness = decodeCompleteness(b['completeness'], '/completeness');
  switch (resultType) {
    case 'vector':
    case 'matrix':
      return { kind: 'series', resultType, series, atMs, completeness };
    case 'scalar': {
      const s = object(b['scalar'], '/scalar');
      const scalar = {
        value: decodeValue(s['value'], '/scalar/value'),
        timestampMs: integer(s['timestamp'], '/scalar/timestamp'),
      };
      return { kind: 'scalar', scalar, atMs, completeness };
    }
    case 'string': {
      const s = object(b['string'], '/string');
      return {
        kind: 'string',
        value: string(s['value'], '/string/value'),
        timestampMs: integer(s['timestamp'], '/string/timestamp'),
        atMs,
        completeness,
      };
    }
  }
}

export type LogsResult =
  | {
      readonly kind: 'streams';
      readonly fromMs: number;
      readonly toMs: number;
      readonly stepMs: number;
      readonly frame: LogFrame;
      readonly cursor: string | null;
      readonly completeness: Completeness;
    }
  | ({ readonly kind: 'series' } & RangeResult);

const NO_COMPLETENESS: Completeness = {
  truncated: false,
  warnings: [],
  infos: [],
  queryId: null,
  dataAgeMs: null,
  readCache: null,
  readCacheThroughMs: null,
};

/** Stub. */
export function decodeLogs(_body: unknown): LogsResult {
  return {
    kind: 'streams',
    fromMs: 0,
    toMs: 0,
    stepMs: 0,
    cursor: null,
    completeness: NO_COMPLETENESS,
    frame: {
      direction: 'backward',
      streams: [],
      tsNs: new BigInt64Array(0),
      streamIndex: new Uint32Array(0),
      lines: [],
      levels: new Uint8Array(0),
      metadata: [],
      parsed: [],
    },
  };
}

/** Stub. */
export function decodeVolume(_body: unknown): RangeResult {
  return { startMs: 0, endMs: 0, stepMs: 0, series: [], completeness: NO_COMPLETENESS };
}
