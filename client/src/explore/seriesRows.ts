/** Stub (tests first, plan #63 §5). */
import { MAX_SERIES } from '../engine/canvas2d/Canvas2DEngine';
import type { ExploreResult } from '../vis/autovis';

export interface SeriesRow {
  readonly key: string;
  readonly name: string;
  readonly colourIndex: number | null;
  readonly last: number | null;
  readonly max: number | null;
}
export type SortColumn = 'series' | 'last' | 'max';
export interface SortState {
  readonly column: SortColumn;
  readonly direction: 'ascending' | 'descending';
}

export function seriesRows(_r: ExploreResult): SeriesRow[] {
  return [];
}

export function sortRows(rows: readonly SeriesRow[], _s: SortState | null): SeriesRow[] {
  return [...rows];
}

export function nextSort(_current: SortState | null, column: SortColumn): SortState {
  return { column, direction: 'ascending' };
}

export function toggleIsolation(_current: string | null, _key: string): string | null {
  return null;
}

export const TABLE_ROWS = MAX_SERIES;
