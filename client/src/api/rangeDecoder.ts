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
  /** Per series: 1 where the validity bitmap marks the slot null; null when none is (#304 §A.3). */
  readonly absent?: readonly (Uint8Array | null)[];
}

export interface RangeDecoder {
  decode(body: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<DecodedRange>;
  /** The result's series array is the chunk's (by identity, `chunkRefs`). */
  register(series: readonly SeriesFrame[], m: DecodedRange): void;
  /** A decoded chunk no array will hold (the result was refused or abandoned): free it now. */
  release(m: DecodedRange): void;
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
  /** Aborted by the request's signal (a superseded query, T04-013). */
  aborted: number;
  /** `HttpApi` retried a declined body as JSON. */
  retried: number;
  /** Body bytes the engine's pool reported consumed (`decode-credit`). */
  credited: number;
}

export const decodeStats: DecodeStats = {
  begun: 0,
  done: 0,
  failed: 0,
  aborted: 0,
  retried: 0,
  credited: 0,
};

let slot: RangeDecoder | null = null;

export function setRangeDecoder(d: RangeDecoder | null): void {
  slot = d;
}

export function rangeDecoder(): RangeDecoder | null {
  return slot;
}

/** A session error as `EngineDeclined` or `DecodeFailed` (the engine side throws plain errors). */
function normalised(e: unknown): unknown {
  if (e instanceof EngineDeclined || e instanceof DecodeFailed) return e;
  if (typeof e !== 'object' || e === null) return e;
  const o = e as {
    name?: unknown;
    reason?: unknown;
    kind?: unknown;
    message?: unknown;
    row?: unknown;
    coverage?: unknown;
    planned?: unknown;
  };
  const message = typeof o.message === 'string' ? o.message : '';
  if (o.name === 'EngineDeclined') {
    const r = o.reason;
    const reason: DeclineReason = r === 'limit' || r === 'ids' || r === 'busy' ? r : 'gone';
    return new EngineDeclined(reason, message === '' ? undefined : message);
  }
  if (o.name === 'DecodeFailed') {
    return new DecodeFailed(o.kind === 'error' ? 'error' : 'invalid', message, {
      row: (o.row ?? null) as WireErrorRow | null,
      coverage: (o.coverage ?? null) as WireCoverage | null,
      planned: typeof o.planned === 'string' ? o.planned : null,
    });
  }
  return e;
}

/** The signal's abort reason (an `AbortError` when none was given). */
function abortReason(signal: AbortSignal): Error {
  const r: unknown = signal.reason;
  return r instanceof Error ? r : new DOMException('The operation was aborted.', 'AbortError');
}

/**
 * A decoder over `open`'s sessions (§4.4): each read of `body` is posted whole as its exact bytes
 * (the view's own buffer when it spans it, else a copy); a read over `MAX_CHUNK` is never posted
 * (`limit`). Reading pauses while the posted bytes not yet credited are at or above
 * `PAUSE_THRESHOLD_BYTES` and resumes on the credit that brings them under it. An abort, a
 * decline or a failure cancels the reader and aborts the session. `open` throwing (`busy`,
 * `gone`) leaves the body unread.
 */
export function streamDecoder(
  open: () => DecodeSession,
  register: RangeDecoder['register'],
  release: RangeDecoder['release'],
): RangeDecoder {
  return {
    async decode(body, signal) {
      if (signal?.aborted === true) throw abortReason(signal);
      let s: DecodeSession;
      try {
        s = open();
      } catch (e) {
        void body.cancel().catch(() => undefined);
        throw normalised(e);
      }
      decodeStats.begun++;
      const reader = body.getReader();
      let outstanding = 0;
      let wake: () => void = () => undefined;
      // Set by the result's rejection (a failure, a decline) while the loop reads or waits.
      const state = { failed: false };
      const failed = (): boolean => state.failed;
      const cancel = (): void => {
        void reader.cancel().catch(() => undefined);
      };
      s.onCredit((n) => {
        outstanding -= n;
        decodeStats.credited += n;
        if (outstanding < PAUSE_THRESHOLD_BYTES) wake();
      });
      s.result.catch(() => {
        state.failed = true;
        cancel();
        wake();
      });
      const onAbort = (): void => {
        cancel();
        wake();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const aborted = (): boolean => signal?.aborted === true;
      try {
        for (;;) {
          while (outstanding >= PAUSE_THRESHOLD_BYTES && !aborted() && !failed()) {
            await new Promise<void>((r) => {
              wake = r;
            });
          }
          if (aborted() || failed()) break;
          let r: ReadableStreamReadResult<Uint8Array>;
          try {
            r = await reader.read();
          } catch (e) {
            if (aborted() || failed()) break;
            throw e;
          }
          if (r.done) {
            s.end();
            break;
          }
          const v = r.value;
          if (v.byteLength > MAX_CHUNK) throw new EngineDeclined('limit', 'a read over max_chunk');
          const whole = v.byteOffset === 0 && v.byteLength === v.buffer.byteLength;
          const buf = (whole ? v.buffer : v.slice().buffer) as ArrayBuffer;
          outstanding += v.byteLength;
          s.post(buf);
        }
        if (aborted() && signal !== undefined) throw abortReason(signal);
        const m = await new Promise<DecodedRange>((resolve, reject) => {
          const stop = (): void => {
            if (signal !== undefined) reject(abortReason(signal));
          };
          signal?.addEventListener('abort', stop, { once: true });
          s.result.then(resolve, reject).finally(() => {
            signal?.removeEventListener('abort', stop);
          });
        });
        decodeStats.done++;
        return m;
      } catch (e) {
        s.abort();
        cancel();
        // A result that arrived anyway (an abort racing the last read) is never registered.
        void s.result.then(release, () => undefined);
        if (aborted() && signal !== undefined) {
          decodeStats.aborted++;
          throw abortReason(signal);
        }
        decodeStats.failed++;
        throw normalised(e);
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    },
    register,
    release,
  };
}
