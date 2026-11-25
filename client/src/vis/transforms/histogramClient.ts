/**
 * The main-thread side of the per-panel histogram worker (T21-016, PRF-005; plan #208 Part 1 §4.4).
 * `runHistogram` copies the series into batches of ≤ 25 000-sample chunks, posts a batch when the
 * step reaches 8 ms, then yields; the last batch is posted without a yield, and the worker's reply
 * resolves the run. A newer run of the panel, an abort or `disposeHistogram` rejects the pending
 * run with an `AbortError` and terminates its worker; replies of an older run are dropped. The
 * early results (`le` series, the sample cap, no series) are decided here without a worker.
 */
import type { Completeness } from '../../data/decode';
import type { SeriesFrame } from '../../data/frames';
import {
  histogram,
  MAX_HIST_SAMPLES,
  type HistogramOptions,
  type HistogramResult,
} from './histogram';
import type { HistogramReply, HistogramRequest } from './histogram.worker';
import { abortError, STEP_MS, yieldToMain } from './slice';

/** Samples per copied chunk: one step copies at most one chunk past the 8 ms check. */
const CHUNK = 25_000;

export interface HistogramWorkerLike {
  postMessage(m: HistogramRequest, transfer: Transferable[]): void;
  onmessage: ((e: MessageEvent<HistogramReply>) => void) | null;
  onerror: ((e: Event) => void) | null;
  terminate(): void;
}

export interface HistogramEnv {
  now(): number;
  yieldNow(): Promise<void>;
  createWorker(): HistogramWorkerLike;
  /** Told the number of samples of each copied chunk (tests drive their clock with it). */
  copied(n: number): void;
}

const DEFAULT_ENV: HistogramEnv = {
  now: () => performance.now(),
  yieldNow: yieldToMain,
  createWorker: () =>
    new Worker(new URL('./histogram.worker.ts', import.meta.url), {
      type: 'module',
    }) as unknown as HistogramWorkerLike,
  copied: () => undefined,
};

let env: HistogramEnv = DEFAULT_ENV;

/** Tests only: replaces parts of the environment; null restores the defaults. */
export function setHistogramEnv(e: Partial<HistogramEnv> | null): void {
  env = e === null ? DEFAULT_ENV : { ...DEFAULT_ENV, ...e };
}

interface Pending {
  readonly resolve: (r: HistogramResult) => void;
  readonly reject: (e: unknown) => void;
  readonly cleanup: () => void;
}

/** One panel's worker and its newest run. */
interface Slot {
  runId: number;
  worker: HistogramWorkerLike | null;
  pending: Pending | null;
}

const slots = new Map<string, Slot>();

/** Settles the pending run (if any) with `settle`, after removing its abort listener. */
function finish(slot: Slot, settle: (p: Pending) => void): void {
  const p = slot.pending;
  if (p === null) return;
  slot.pending = null;
  p.cleanup();
  settle(p);
}

/** Terminates the slot's worker; the next run creates a new one. */
function dropWorker(slot: Slot): void {
  slot.worker?.terminate();
  slot.worker = null;
}

/** Rejects the pending run with an `AbortError` and terminates its worker. */
function abortPending(slot: Slot): void {
  if (slot.pending === null) return;
  finish(slot, (p) => {
    p.reject(abortError());
  });
  dropWorker(slot);
}

/** The slot's worker, created and wired on first use. */
function workerOf(slot: Slot): HistogramWorkerLike {
  if (slot.worker !== null) return slot.worker;
  const w = env.createWorker();
  const failed = (message: string): void => {
    if (slot.worker !== w || slot.pending === null) return;
    finish(slot, (p) => {
      p.reject(new Error(message));
    });
    dropWorker(slot);
  };
  w.onmessage = (e) => {
    const reply = e.data;
    if (slot.worker !== w || reply.runId !== slot.runId || slot.pending === null) return;
    if ('error' in reply) {
      failed(reply.error);
      return;
    }
    finish(slot, (p) => {
      p.resolve(reply.result);
    });
  };
  w.onerror = () => {
    failed('The histogram worker failed');
  };
  slot.worker = w;
  return w;
}

/**
 * Bins `input` in the panel's worker (T21-016). Rejects with an `AbortError` when a newer run of
 * the panel starts, when `signal` aborts or when the panel is disposed; with an `Error` when the
 * worker fails. Not cancel-safe by dropping the promise: abort `signal` to stop the copying.
 */
export function runHistogram(
  panelId: string,
  runId: number,
  input: readonly SeriesFrame[],
  source: 'instant' | 'range',
  o: HistogramOptions,
  q: Completeness,
  signal: AbortSignal,
): Promise<HistogramResult> {
  let slot = slots.get(panelId);
  if (slot === undefined) {
    slot = { runId, worker: null, pending: null };
    slots.set(panelId, slot);
  }
  // Always first: any early result below also supersedes the older run.
  abortPending(slot);
  slot.runId = runId;
  if (signal.aborted) return Promise.reject(abortError());
  let samples = 0;
  let le = false;
  for (const s of input) {
    samples += s.timestamps.length;
    if (s.labels['le'] !== undefined) le = true;
  }
  if (le || samples > MAX_HIST_SAMPLES || input.length === 0)
    return Promise.resolve(histogram(input, source, o, q));

  const own = slot;
  const worker = workerOf(own);
  return new Promise<HistogramResult>((resolve, reject) => {
    const onAbort = (): void => {
      if (own.runId !== runId) return;
      abortPending(own);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    own.pending = {
      resolve,
      reject,
      cleanup: () => {
        signal.removeEventListener('abort', onAbort);
      },
    };
    void feed(own, worker, runId, input, source, o, q, signal).catch((err: unknown) => {
      if (own.runId !== runId) return;
      finish(own, (p) => {
        p.reject(err);
      });
      dropWorker(own);
    });
  });
}

/** Copies and posts the batches of one run; stops when the run is superseded or aborted. */
async function feed(
  slot: Slot,
  worker: HistogramWorkerLike,
  runId: number,
  input: readonly SeriesFrame[],
  source: 'instant' | 'range',
  o: HistogramOptions,
  q: Completeness,
  signal: AbortSignal,
): Promise<void> {
  let batch: HistogramRequest['batch'] = [];
  let buffers: ArrayBuffer[] = [];
  const post = (last: boolean): void => {
    worker.postMessage({ runId, source, o, q, batch, last }, buffers);
    batch = [];
    buffers = [];
  };
  let t0 = env.now();
  for (let si = 0; si < input.length; si++) {
    const s = input[si];
    if (s === undefined) continue;
    const n = s.timestamps.length;
    const chunks = Math.max(1, Math.ceil(n / CHUNK));
    for (let c = 0; c < chunks; c++) {
      const from = c * CHUNK;
      const to = Math.min(n, from + CHUNK);
      const timestamps = s.timestamps.slice(from, to);
      const values = s.values.slice(from, to);
      if (n > 0) env.copied(to - from);
      batch.push({ key: s.key, labels: s.labels, timestamps, values, cont: c > 0 });
      buffers.push(timestamps.buffer, values.buffer);
      const final = si === input.length - 1 && c === chunks - 1;
      if (final || env.now() - t0 < STEP_MS) continue;
      post(false);
      await env.yieldNow();
      if (slot.runId !== runId || slot.pending === null || signal.aborted) return;
      t0 = env.now();
    }
  }
  post(true);
}

/** Rejects the panel's pending run with an `AbortError`, terminates its worker and forgets it. */
export function disposeHistogram(panelId: string): void {
  const slot = slots.get(panelId);
  if (slot === undefined) return;
  abortPending(slot);
  dropWorker(slot);
  slots.delete(panelId);
}
