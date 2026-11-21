/** Stub (tests first, plan #63 Part C §3.3). */
import type { JSX } from 'react';
import type { Unit } from '../../engine/api';
import type { SeriesRow, SortColumn, SortState } from '../../explore/seriesRows';

export interface SeriesTableProps {
  readonly rows: readonly SeriesRow[];
  readonly total: number;
  readonly sort: SortState | null;
  readonly onSort: (column: SortColumn) => void;
  readonly isolatedKey: string | null;
  readonly onIsolate: ((key: string) => void) | null;
  readonly swatches: boolean;
  readonly unit: Unit;
}
export function SeriesTable(_p: SeriesTableProps): JSX.Element {
  throw new Error('not implemented');
}
