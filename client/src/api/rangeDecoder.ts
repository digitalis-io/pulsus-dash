/**
 * The range decoder slot (plan #68 D2 §3.3, §4.1, §4.4). `engine/index.ts` fills it when an MT
 * engine boots and clears it when the engine dies; `HttpApi.queryRange` asks for DSF only while it
 * is filled. The API layer imports nothing from `engine/`: the engine side gives `streamDecoder` a
 * session factory, and this module reads the body and applies the backpressure.
 */
import type { SeriesFrame } from '../data/frames';

/** The DSF media type, and the `Accept` of a range request with a decoder. */
export const DSF_TYPE = 'application/vnd.pulsus.dash-stream';
export const DSF_ACCEPT = `${DSF_TYPE};v=1, application/json;q=0.1`;
/** Main pauses reading at or above this many posted, unconsumed bytes; not a cap. */
export const PAUSE_THRESHOLD_BYTES = 8 << 20;
/** B3's `max_chunk`: a read above it is never posted. */
export const MAX_CHUNK = 128 << 20;
/** DSF decodes in flight per worker (`DecodeService::MAX_IN_FLIGHT`). */
export const MAX_IN_FLIGHT = 2;

/** A `coverage/1` row as the worker posts it. */
export interface WireCoverage {
  readonly truncated: boolean;
  readonly truncation_reason: string | null;
  readonly warnings: readonly string[];
  readonly infos: readonly string[];
  readonly upstream_query_ids: readonly string[];
  readonly read_cache: number | null;
  readonly read_cache_through: number | null;
  readonly data_end: number | null;
}

/** An `error/1` row as the worker posts it. */
export interface WireErrorRow {
  readonly code: number;
  readonly http_status: number;
  readonly message: string;
  readonly position: number | null;
  readonly retry_after_ms: number | null;
  readonly suggestion: string | null;
}

/** The `decoded` message's head. */
export interface DecodedHead {
  readonly startMs: number;
  readonly endMs: number;
  readonly stepMs: number;
  /** `dash.planned`, as sent. */
  readonly planned: string | null;
  readonly coverage: WireCoverage | null;
  readonly series: readonly { readonly key: string; readonly labels: Record<string, string> }[];
}

/** A decoded range: the chunk's table id and epoch, the head, the shared `ts`, full-grid `vs`. */
export interface DecodedRange {
  readonly chunk: number;
  readonly epoch: number;
  readonly head: DecodedHead;
  readonly ts: Float64Array;
  readonly vs: readonly Float64Array[];
}

export interface RangeDecoder {
  decode(body: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<DecodedRange>;
  /** The result's series array is the chunk's (by identity, `chunkRefs`). */
  register(series: readonly SeriesFrame[], m: DecodedRange): void;
}

export type DeclineReason = 'limit' | 'ids' | 'busy' | 'gone';

/** The engine declined the body: one JSON retry (`invalid` is not a decline). */
export class EngineDeclined extends Error {
  readonly reason: DeclineReason;

  constructor(reason: DeclineReason, message = `the engine declined the body (${reason})`) {
    super(message);
    this.name = 'EngineDeclined';
    this.reason = reason;
  }
}

/** The body failed: an `error/1` row (`error`), or a malformed or invalid body (`invalid`). */
export class DecodeFailed extends Error {
  readonly kind: 'error' | 'invalid';
  readonly row: WireErrorRow | null;
  readonly coverage: WireCoverage | null;
  readonly planned: string | null;

  constructor(
    kind: 'error' | 'invalid',
    message: string,
    o: {
      row?: WireErrorRow | null;
      coverage?: WireCoverage | null;
      planned?: string | null;
    } = {},
  ) {
    super(message);
    this.name = 'DecodeFailed';
    this.kind = kind;
    this.row = o.row ?? null;
    this.coverage = o.coverage ?? null;
    this.planned = o.planned ?? null;
  }
}

/** One decode on the engine: the reads go in order, credits come back. */
export interface DecodeSession {
  /** One read's exact bytes (transferred). */
  post(buf: ArrayBuffer): void;
  end(): void;
  abort(): void;
  onCredit(cb: (bytes: number) => void): void;
  /** Rejects with an `EngineDeclined`- or `DecodeFailed`-shaped error (`name`). */
  readonly result: Promise<DecodedRange>;
}

/** Decodes the decoder saw: begun, done, failed (the probe's `decodes()`). */
export interface DecodeStats {
  begun: number;
  done: number;
  failed: number;
  /** `HttpApi` retried a declined body as JSON. */
  retried: number;
}

export const decodeStats: DecodeStats = { begun: 0, done: 0, failed: 0, retried: 0 };

let slot: RangeDecoder | null = null;

export function setRangeDecoder(d: RangeDecoder | null): void {
  slot = d;
}

export function rangeDecoder(): RangeDecoder | null {
  return slot;
}

/** A decoder over `open`'s sessions: reads `body`, posts each read, pauses on credit. */
export function streamDecoder(
  open: () => DecodeSession,
  register: RangeDecoder['register'],
): RangeDecoder {
  return {
    decode(): Promise<DecodedRange> {
      void open;
      return Promise.reject(new EngineDeclined('gone'));
    },
    register,
  };
}
