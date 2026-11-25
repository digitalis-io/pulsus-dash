/** The per-panel histogram worker (T21-016). Stub: the tests come first. */
import type { Completeness } from '../../data/decode';
import type { Labels } from '../../data/frames';
import type { HistogramOptions, HistogramResult } from './histogram';

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

export function onHistogramMessage(st: WorkerState, m: HistogramRequest): HistogramReply | null {
  void [st, m];
  return null;
}

export function resultTransfer(r: HistogramResult): ArrayBuffer[] {
  void r;
  return [];
}
