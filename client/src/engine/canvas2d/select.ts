/**
 * Click picking (ADR-0025, T25-005, plan #192 §4.3): the mark under a click on the plot, from the
 * last layer draw. Line: the hover row nearest the pointer's y at the snapped time; bars: the
 * stacked segment of the drawn (merged) bucket under the pointer; heatmap: the bucket under it.
 */
import type { HoverItem } from '../api';
import type { Span } from './camera';
import type { LayerModel } from './draw';

export function pickItem(
  model: LayerModel,
  view: Span,
  p: { readonly x: number; readonly y: number },
): HoverItem | null {
  void model;
  void view;
  void p;
  return null;
}
