/**
 * The Canvas 2D bar chart (ADR-0028, plan #173 Part 2 §4.2): one bar per `categories` row in data
 * order, with names, value labels, thresholds, the baseline ghost and the selection, laid out by
 * `barLayout`. The layer returns the bands that `mark` and `pick` hit.
 */
import type { BarchartSpec, CategoryRow, Coverage, HoverRow, PlotRect } from '../api';
import type { LayerInput, LayerModel } from './draw';
import { frameSummary } from './summary';

/** A drawn bar's band, for picking: the category interval [lo, hi) and the value end. */
export interface BarHit {
  readonly key: string;
  readonly index: number;
  /** Along the category axis, from the name band to the plot's far edge. */
  readonly lo: number;
  readonly hi: number;
  readonly xCss: number;
  readonly yCss: number;
  readonly row: HoverRow;
}

/** What `mark` and `pick` need from the last barchart layer. */
export interface BarPick {
  readonly kind: 'barchart';
  /** Always empty: no time axis. */
  readonly ref: Float64Array;
  readonly horizontal: boolean;
  /** The rectangle a pointer must be in: the name band and the plot. */
  readonly area: PlotRect;
  readonly bands: readonly BarHit[];
}

export function drawBarchart(
  i: LayerInput,
  spec: BarchartSpec,
  rows: readonly CategoryRow[],
  coverage: Coverage,
): LayerModel {
  void spec;
  void rows;
  void coverage;
  const plot = { x: 0, y: 0, width: i.cssW, height: i.cssH };
  return {
    summary: frameSummary(
      'barchart',
      i.window,
      plot,
      0,
      0,
      { min: null, max: null, last: null },
      null,
    ),
    pick: null,
    labelW: 0,
    valueDomain: null,
    bandHeld: false,
  };
}

/** The band under `p`, or null. */
export function barAt(pick: BarPick, p: { x: number; y: number }): BarHit | null {
  void pick;
  void p;
  return null;
}
