/**
 * The per-panel histogram worker (T21-016; plan #208 Part 1 §3.4, §4.4). The main thread
 * (`histogramClient.ts`) posts the series in batches; the worker appends them per run, and on the
 * last batch replies with `histogram()`'s result, its typed-array buffers transferred. A message
 * of a new `runId` resets the state. `onmessage` is bound only inside a dedicated worker, so the
 * tests import the protocol functions directly.
 */
import type { Completeness } from '../../data/decode';
import type { Labels } from '../../data/frames';
import { histogram, type HistogramOptions, type HistogramResult } from './histogram';

export interface HistogramRequest {
  readonly runId: number;
  readonly source: 'instant' | 'range';
  readonly o: HistogramOptions;
  readonly q: Completeness;
  readonly batch: {
    readonly key: string;
    readonly labels: Labels;
    readonly timestamps: Float64Array;
    readonly values: Float64Array;
    /** Continues the previous entry's series (a chunk after the first). */
    readonly cont: boolean;
  }[];
  readonly last: boolean;
}

export type HistogramReply =
  | { readonly runId: number; readonly result: HistogramResult }
  | { readonly runId: number; readonly error: string };

export interface WorkerState {
  runId: number | null;
  series: HistogramRequest['batch'][number][];
}

/**
 * `a` followed by `b`. `a` may be a view at the start of a larger buffer (an earlier append): the
 * result reuses that buffer while it fits and otherwise doubles it, so appending n chunks copies
 * O(total) values.
 */
function append(a: Float64Array, b: Float64Array): Float64Array {
  const need = a.length + b.length;
  const buffer = a.buffer;
  const capacity =
    a.byteOffset === 0 && buffer instanceof ArrayBuffer
      ? buffer.byteLength / Float64Array.BYTES_PER_ELEMENT
      : 0;
  if (buffer instanceof ArrayBuffer && capacity >= need) {
    const out = new Float64Array(buffer, 0, need);
    out.set(b, a.length);
    return out;
  }
  const size = Math.max(need, 2 * a.length) * Float64Array.BYTES_PER_ELEMENT;
  const out = new Float64Array(new ArrayBuffer(size), 0, need);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/**
 * Applies one request: a new `runId` resets the state; entries are appended (`cont` joins the
 * previous entry; empty entries are kept, so the key joins its source group and the duplicate
 * merge); on `last` the reply, or `{error}` when `histogram()` throws.
 */
export function onHistogramMessage(st: WorkerState, m: HistogramRequest): HistogramReply | null {
  if (st.runId !== m.runId) {
    st.runId = m.runId;
    st.series = [];
  }
  for (const e of m.batch) {
    const prev = st.series[st.series.length - 1];
    if (e.cont && prev !== undefined) {
      st.series[st.series.length - 1] = {
        ...prev,
        timestamps: append(prev.timestamps, e.timestamps),
        values: append(prev.values, e.values),
      };
    } else st.series.push(e);
  }
  if (!m.last) return null;
  const input = st.series;
  st.series = [];
  try {
    return { runId: m.runId, result: histogram(input, m.source, m.o, m.q) };
  } catch (err) {
    return { runId: m.runId, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Every typed-array buffer of a frame result, once each: the transfer list of the reply. */
export function resultTransfer(r: HistogramResult): ArrayBuffer[] {
  if (r.kind !== 'frame') return [];
  const f = r.frame;
  const out = new Set<ArrayBuffer>();
  for (const a of [
    f.edges,
    f.counts,
    f.contrib.offsets,
    f.contrib.bins,
    f.contrib.counts,
    f.sorted.values,
    f.sorted.offsets,
  ])
    if (a.buffer instanceof ArrayBuffer) out.add(a.buffer);
  return [...out];
}

interface WorkerScope {
  onmessage: ((e: MessageEvent<HistogramRequest>) => void) | null;
  postMessage(m: HistogramReply, transfer: Transferable[]): void;
}

/** Whether this module runs in a dedicated worker (not on the main thread or in a test). */
function inDedicatedWorker(): boolean {
  const scope = globalThis as { DedicatedWorkerGlobalScope?: abstract new () => unknown };
  const ctor = scope.DedicatedWorkerGlobalScope;
  return ctor !== undefined && globalThis instanceof ctor;
}

if (inDedicatedWorker()) {
  const scope = globalThis as unknown as WorkerScope;
  const state: WorkerState = { runId: null, series: [] };
  scope.onmessage = (e) => {
    const reply = onHistogramMessage(state, e.data);
    if (reply === null) return;
    scope.postMessage(reply, 'result' in reply ? resultTransfer(reply.result) : []);
  };
}
