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

const row = (
  key: string,
  max: number | null,
  last: number | null,
  mean: number | null = null,
): SeriesRow => ({
  key,
  name: key,
  colourIndex: 0,
  last,
  max,
  mean,
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
        mean: 2,
      },
      {
        key: series[1]?.key,
        name: 'm{job="b"}',
        colourIndex: series[1] === undefined ? null : seriesColourIndex(series[1]),
        last: null,
        max: null,
        mean: null,
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
        mean: 7,
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

  it('seriesRows mean', () => {
    const mean = (values: number[]): number | null => {
      const [series] = fixture(
        [{ labels: { __name__: 'm' }, values }],
        values.map((_, i) => i),
      );
      if (series === undefined) throw new Error('no series');
      const rows = seriesRows({
        kind: 'series',
        source: 'range',
        series: [series],
        stepMs: 1,
        completeness: EMPTY_COMPLETENESS,
      });
      return rows[0]?.mean ?? null;
    };
    expect(mean([1, N, 3])).toBe(2);
    expect(mean([Infinity, -Infinity])).toBeNull();
    expect(mean([N])).toBeNull();
  });

  it('sort by mean', () => {
    const rows = [row('x', 0, 0, 1), row('y', 0, 0, null), row('z', 0, 0, 3)];
    expect(keys(sortRows(rows, { column: 'mean', direction: 'descending' }))).toEqual([
      'z',
      'x',
      'y',
    ]);
    expect(nextSort(null, 'mean')).toEqual({ column: 'mean', direction: 'descending' });
  });

  // #204: a legend name template names the rows; their keys stay the series identity, so two
  // series with one rendered name stay two rows and sort apart by key.
  it('a legend name template names the rows, keyed by series', () => {
    const series = fixture([
      { labels: { __name__: 'up', instance: 'n2', job: 'b' }, values: [1, 1] },
      { labels: { __name__: 'up', instance: 'n1', job: 'b' }, values: [2, 2] },
      { labels: { __name__: 'up', instance: 'n1', job: 'a' }, values: [3, 3] },
    ]);
    const r = {
      kind: 'series' as const,
      source: 'range' as const,
      series,
      stepMs: 1,
      completeness: EMPTY_COMPLETENESS,
    };
    const rows = seriesRows(r, '{{instance}} select');
    expect(rows.map((x) => [x.key, x.name])).toEqual([
      [series[0]?.key, 'n2 select'],
      [series[1]?.key, 'n1 select'],
      [series[2]?.key, 'n1 select'],
    ]);
    expect(new Set(rows.map((x) => x.key)).size).toBe(3);
    expect(keys(sortRows(rows, { column: 'series', direction: 'ascending' }))).toEqual([
      series[1]?.key,
      series[2]?.key,
      series[0]?.key,
    ]);
    expect(seriesRows(r, null).map((x) => x.name)).toEqual([
      'up{instance="n2", job="b"}',
      'up{instance="n1", job="b"}',
      'up{instance="n1", job="a"}',
    ]);
  });
});
