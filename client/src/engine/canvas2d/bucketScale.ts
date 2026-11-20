import type { PlotRect } from '../api';

export interface BucketRow {
  readonly lower: number;
  readonly upper: number;
  readonly y0: number;
  readonly y1: number;
}

export interface BucketScale {
  readonly kind: 'log' | 'linear';
  readonly rows: readonly BucketRow[];
  readonly infBand: { y0: number; y1: number } | null;
  readonly ticks: readonly number[];
  /** The y (CSS px) of a value on the finite scale. */
  readonly y: (v: number) => number;
}

export function bucketScale(
  _bounds: Float64Array,
  _plot: PlotRect,
  _labelHeightPx: number,
): BucketScale {
  throw new Error('not implemented');
}
