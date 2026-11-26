/**
 * The bar chart's tooltip (DOM; plan #173 Part 2 §4.4): the bar under the pointer.
 */
import type { JSX } from 'react';
import type { CategoryRow, MarkEvent, Unit } from '../engine/api';

export function MarkTooltip(p: {
  mark: MarkEvent | null;
  row: CategoryRow | undefined;
  unit: Unit;
  ghost: boolean;
}): JSX.Element {
  void p;
  return <div data-mark-tooltip="" aria-hidden="true" hidden />;
}
