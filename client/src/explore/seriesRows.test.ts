import { describe, expect, it } from 'vitest';
import { seriesColourIndex } from '../engine/canvas2d/palette';
import { EMPTY_COMPLETENESS, fixture, N } from '../test/histogramFixtures';
import { SCALAR_KEY, scalarSeries } from '../vis/framePlan';
import {
  nextSort,
  seriesRows,
  sortRows,
  TABLE_ROWS,
  toggleIsolation,
  type SeriesRow,
} from './seriesRows';

const row = (key: string, max: number | null, last: number | null): SeriesRow => ({
  key,
  name: key,
  colourIndex: 0,
  last,
  max,
});
const ROWS = [row('a', 3, 1), row('b', 2, 2), row('c', null, null), row('d', 3, 0.5)];
const keys = (rows: readonly SeriesRow[]) => rows.map((r) => r.key);

describe('unit:series-rows', () => {
  it('sorts by max and last, nulls last, ties by name', () => {
    expect(keys(sortRows(ROWS, { column: 'max', direction: 'descending' }))).toEqual([
      'a',
      'd',
      'b',
      'c',
    ]);
    expect(keys(sortRows(ROWS, { column: 'max', direction: 'ascending' }))).toEqual([
      'b',
      'a',
      'd',
      'c',
    ]);
    expect(keys(sortRows(ROWS, { column: 'last', direction: 'descending' }))).toEqual([
      'b',
      'a',
      'd',
      'c',
    ]);
    expect(keys(sortRows(ROWS, null))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('builds rows from series and from a scalar', () => {
    const series = fixture(
      [
        { labels: { __name__: 'm', job: 'a' }, values: [1, N, 3, N] },
        { labels: { __name__: 'm', job: 'b' }, values: [N, N, N, N] },
      ],
      [0, 1, 2, 3],
    );
    expect(
      seriesRows({
        kind: 'series',
        source: 'range',
        series,
        stepMs: 1,
        completeness: EMPTY_COMPLETENESS,
      }),
    ).toEqual([
      {
        key: series[0]?.key,
        name: 'm{job="a"}',
        colourIndex: series[0] === undefined ? null : seriesColourIndex(series[0]),
        last: 3,
        max: 3,
      },
      {
        key: series[1]?.key,
        name: 'm{job="b"}',
        colourIndex: series[1] === undefined ? null : seriesColourIndex(series[1]),
        last: null,
        max: null,
      },
    ]);
    const scalar = { value: 7, timestampMs: 0 };
    expect(seriesRows({ kind: 'scalar', scalar, completeness: EMPTY_COMPLETENESS })).toEqual([
      {
        key: SCALAR_KEY,
        name: 'scalar',
        colourIndex: seriesColourIndex(scalarSeries(scalar)),
        last: 7,
        max: 7,
      },
    ]);
    expect(seriesRows({ kind: 'string', value: 's', completeness: EMPTY_COMPLETENESS })).toEqual(
      [],
    );
    expect(TABLE_ROWS).toBe(500);
  });

  it('next sort and isolation toggle', () => {
    expect(nextSort(null, 'max')).toEqual({ column: 'max', direction: 'descending' });
    expect(nextSort({ column: 'max', direction: 'descending' }, 'max')).toEqual({
      column: 'max',
      direction: 'ascending',
    });
    expect(nextSort({ column: 'max', direction: 'descending' }, 'series')).toEqual({
      column: 'series',
      direction: 'ascending',
    });
    expect(toggleIsolation(null, 'k')).toBe('k');
    expect(toggleIsolation('k', 'k')).toBeNull();
  });
});
