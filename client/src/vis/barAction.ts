/** The bar chart's pick decision (plan #173 Part 3a §3.4). Stub (tests first). */
import type { Mark } from '../data/frames';
import type { PickEvent, TimeWindow } from '../engine/api';
import type { InspectOrigin, InspectorTarget, Selection } from '../inspector/types';
import type { BoardFilter } from '../state/boardParams';
import type { BarchartModel } from './barchart';

export type FilterOp = { readonly key: string; readonly value: string | null };
export type BarAction =
  | { readonly kind: 'none' }
  | { readonly kind: 'clear' }
  | { readonly kind: 'brush'; readonly selection: Selection }
  | {
      readonly kind: 'click';
      readonly target: Extract<InspectorTarget, { type: 'mark' }>;
      readonly selection: Selection;
      readonly filter: FilterOp | null;
    };
export interface BarContext {
  readonly model: BarchartModel;
  readonly surface: 'board' | 'explore';
  readonly filters: readonly BoardFilter[];
  readonly origin: Omit<InspectOrigin, 'window'>;
  readonly window: TimeWindow;
}
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function barAction(e: PickEvent, c: BarContext): BarAction {
  return { kind: 'none' };
}
export function barHint(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  row: Mark,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  c: Pick<BarContext, 'model' | 'surface'>,
): string | null {
  return null;
}
