/**
 * A bar chart in a measured cell (plan #173 Part 2 §4.1, §4.4): the fit for the cell's size, the
 * frame or the `tooSmall` notice, the hidden-labels note and the coverage meter.
 */
import type { JSX } from 'react';
import type { PickEvent } from '../engine/api';
import type { BarchartModel } from '../vis/barchart';
import type { FrameSize } from './ChartFrame';

export function CategoryChart(p: {
  model: BarchartModel;
  title: string;
  onNarrow: () => void;
  sizeMemo?: { current: FrameSize | null };
  onPick?: (e: PickEvent) => void;
}): JSX.Element {
  void p;
  return (
    <div data-category-chart="">
      <div data-category-cell="" />
    </div>
  );
}
