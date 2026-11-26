/**
 * The bar chart's pick decision (plan #173 Part 3a §3.4; T22-005, T22-007, VIZ-037, T25 §4.2): one
 * pure function turns an engine `pick` into what the caller does: nothing, clear the selection,
 * select a brush, or inspect a bar with its selection and the board filter toggle. `barHint` is the
 * tooltip line saying why a click does not filter. The surfaces apply the action (#173 Part 3b).
 */
import { selectionOf } from '../charts/inspectTarget';
import type { Mark } from '../data/frames';
import type { PickEvent, TimeWindow } from '../engine/api';
import { t } from '../i18n/t';
import type { InspectOrigin, InspectorTarget, Selection } from '../inspector/types';
import type { BoardFilter } from '../state/boardParams';
import type { BarchartModel } from './barchart';
import { filterBlockText, filterPair } from './reduce';

/** A board filter change: set `key` to `value`, or remove it (null). */
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
  /** Board `f=`, in URL order; [] on Explore. */
  readonly filters: readonly BoardFilter[];
  readonly origin: Omit<InspectOrigin, 'window'>;
  /** The window the rows were reduced over. */
  readonly window: TimeWindow;
}

/**
 * `[]` → `clear`; a brush → its keys as the selection; a click on a key not in `model.all` →
 * `none`. Any other click inspects the row: its `mark` target, `selectionOf` it, and on a board
 * with a filter pair {k, v} the toggle: remove k when the filters hold {k, v}, else set it to v.
 */
export function barAction(e: PickEvent, c: BarContext): BarAction {
  if (e.keys.length === 0) return { kind: 'clear' };
  if (e.gesture === 'brush') {
    return { kind: 'brush', selection: { keys: [...e.keys], fromMs: null, toMs: null } };
  }
  const key = e.keys[0];
  const row = c.model.all.find((r) => r.key === key);
  if (row === undefined) return { kind: 'none' };
  const target: Extract<InspectorTarget, { type: 'mark' }> = {
    type: 'mark',
    target: {
      panelId: c.origin.panelId,
      kind: 'barchart',
      title: c.origin.title,
      mark: {
        key: row.key,
        labels: row.labels,
        name: row.name,
        value: row.value,
        state: row.state,
        baseline: row.baseline,
        anomaly: row.anomaly,
      },
      members: row.members,
      unit: c.model.spec.unit,
      window: c.window,
      query: c.origin.query,
    },
  };
  let filter: FilterOp | null = null;
  if (c.surface === 'board') {
    const pair = filterPair(row, c.model.label);
    if ('key' in pair) {
      const on = c.filters.some((f) => f.key === pair.key && f.value === pair.value);
      filter = { key: pair.key, value: on ? null : pair.value };
    }
  }
  return { kind: 'click', target, selection: selectionOf(target), filter };
}

/** Why a click on `row` does not filter: on Explore always; on a board without a pair. */
export function barHint(row: Mark, c: Pick<BarContext, 'model' | 'surface'>): string | null {
  if (c.surface === 'explore') return t('bar.filtersOnBoards');
  const pair = filterPair(row, c.model.label);
  return 'key' in pair ? null : filterBlockText(pair);
}
