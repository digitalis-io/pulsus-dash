import type { PlotRect, TimeWindow } from '../api';

export interface Run {
  readonly min: number;
  readonly max: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly count: number;
}

export interface Column {
  readonly x: number;
  readonly min: number;
  readonly max: number;
  readonly last: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly lastMs: number;
  readonly count: number;
  readonly runs: readonly Run[];
  readonly breakBefore: boolean;
}

export function lineColumns(
  _ts: Float64Array,
  _vs: Float64Array,
  _w: TimeWindow,
  _plot: PlotRect,
): (Column | null)[] {
  throw new Error('not implemented');
}

export function mergeBuckets(
  _ts: Float64Array,
  _counts: Float64Array,
  _stride: number,
  _w: TimeWindow,
  _plot: PlotRect,
): { ts: Float64Array; counts: Float64Array } {
  throw new Error('not implemented');
}

export function brushSnapUnit(_msPerPx: number): number {
  throw new Error('not implemented');
}
