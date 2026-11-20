import type { PlotRect } from '../api';
import type { Column } from './columns';
import type { Ctx2D } from './ctx';

/** One line series: one vertex per non-null column, one span per run, dots for lone samples. */
export function drawLineSeries(
  _ctx: Ctx2D,
  _cols: readonly (Column | null)[],
  _plot: PlotRect,
  _y: (v: number) => number,
  _colour: string,
  _lineWidth: number,
): void {
  throw new Error('not implemented');
}

export const AXIS_FONT = '';
export const STAT_FONT = '';
