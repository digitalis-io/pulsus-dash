/**
 * The series table's rows (plan #63 §4.3; SRF-031 subset): one row per series in response order,
 * with its colour, mean, last and max (mean by #64 Part B for the board legend); sorting and the
 * isolation toggle. Explore and the board legend render them (`charts/SeriesTable`).
 */
import { seriesName } from '../data/frames';
import { MAX_SERIES } from '../engine/canvas2d/Canvas2DEngine';
import { seriesColourIndex } from '../engine/canvas2d/palette';
import type { ExploreResult } from '../vis/autovis';
import { SCALAR_KEY, scalarSeries } from '../vis/framePlan';

export interface SeriesRow {
  readonly key: string;
  readonly name: string;
  readonly colourIndex: number | null;
  /** The last non-NaN value; `null` when none. */
  readonly last: number | null;
  /** The largest non-NaN value (±Inf included); `null` when none. */
  readonly max: number | null;
  /** The mean of the non-NaN values (±Inf included); `null` when none or when it is NaN. */
  readonly mean: number | null;
}

export type SortColumn = 'series' | 'mean' | 'last' | 'max';

export interface SortState {
  readonly column: SortColumn;
  readonly direction: 'ascending' | 'descending';
}

/** The rows the table shows at most: the engine's series cap. */
export const TABLE_ROWS = MAX_SERIES;

export function seriesRows(r: ExploreResult): SeriesRow[] {
  switch (r.kind) {
    case 'string':
      return [];
    case 'scalar': {
      const v = Number.isNaN(r.scalar.value) ? null : r.scalar.value;
      return [
        {
          key: SCALAR_KEY,
          name: 'scalar',
          colourIndex: seriesColourIndex(scalarSeries(r.scalar)),
          last: v,
          max: v,
          mean: v,
        },
      ];
    }
    case 'series':
      return r.series.map((s) => {
        let last: number | null = null;
        let max: number | null = null;
        let sum = 0;
        let n = 0;
        for (const v of s.values) {
          if (Number.isNaN(v)) continue;
          last = v;
          if (max === null || v > max) max = v;
          sum += v;
          n += 1;
        }
        const mean = n === 0 || Number.isNaN(sum / n) ? null : sum / n;
        return {
          key: s.key,
          name: seriesName(s.labels),
          colourIndex: seriesColourIndex(s),
          last,
          max,
          mean,
        };
      });
  }
}

const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** `null` state → response order; numbers with `null` last in both directions; ties by name, key. */
export function sortRows(rows: readonly SeriesRow[], s: SortState | null): SeriesRow[] {
  if (s === null) return [...rows];
  const sign = s.direction === 'ascending' ? 1 : -1;
  const column = s.column;
  const primary = (a: SeriesRow, b: SeriesRow): number => {
    if (column === 'series') return sign * byCodeUnits(a.name, b.name);
    const x = a[column];
    const y = b[column];
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
    return x === y ? 0 : sign * (x < y ? -1 : 1);
  };
  return [...rows].sort(
    (a, b) => primary(a, b) || byCodeUnits(a.name, b.name) || byCodeUnits(a.key, b.key),
  );
}

/** A new column sorts `series` ascending and `mean`, `last`, `max` descending; the same one flips. */
export function nextSort(current: SortState | null, column: SortColumn): SortState {
  if (current?.column === column) {
    return {
      column,
      direction: current.direction === 'ascending' ? 'descending' : 'ascending',
    };
  }
  return { column, direction: column === 'series' ? 'ascending' : 'descending' };
}

/** A click on the isolated row restores the full view; any other row isolates that row. */
export function toggleIsolation(current: string | null, key: string): string | null {
  return current === key ? null : key;
}
