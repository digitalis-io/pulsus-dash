/** The main-thread side of the histogram worker (T21-016). Stub: the tests come first. */
import type { Completeness } from '../../data/decode';
import type { SeriesFrame } from '../../data/frames';
import type { HistogramOptions, HistogramResult } from './histogram';
import type { HistogramReply, HistogramRequest } from './histogram.worker';

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
  copied(n: number): void;
}

export function setHistogramEnv(e: Partial<HistogramEnv> | null): void {
  void e;
}

export function runHistogram(
  panelId: string,
  runId: number,
  input: readonly SeriesFrame[],
  source: 'instant' | 'range',
  o: HistogramOptions,
  q: Completeness,
  signal: AbortSignal,
): Promise<HistogramResult> {
  void [panelId, runId, input, source, o, signal];
  return Promise.resolve({ kind: 'tooMany', samples: -1, query: q });
}

export function disposeHistogram(panelId: string): void {
  void panelId;
}
