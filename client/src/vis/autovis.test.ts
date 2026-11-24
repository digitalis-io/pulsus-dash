import { describe, expect, it } from 'vitest';
import type { InstantResult, PlannedQuery, RangeResult, VolumeResult } from '../data/decode';
import type { SeriesFrame } from '../data/frames';
import { EMPTY_COMPLETENESS, fixture, H1, N } from '../test/histogramFixtures';
import { autoVis, chooseVis, fromInstant, fromRange, type ExploreResult } from './autovis';

const PLANNED: PlannedQuery = {
  query: 'q',
  expanded: 'q',
  bytes: 1,
  valueType: 'vector',
  rateCandidate: false,
  rateApplied: false,
  histogram: false,
};

function range(series: readonly SeriesFrame[], stepMs = 5000): RangeResult {
  return {
    planned: PLANNED,
    startMs: 0,
    endMs: 10_000,
    stepMs,
    series,
    completeness: EMPTY_COMPLETENESS,
  };
}

function instant(series: readonly SeriesFrame[], resultType: 'vector' | 'matrix' = 'vector') {
  const r: InstantResult = {
    planned: PLANNED,
    kind: 'series',
    resultType,
    series,
    atMs: 0,
    completeness: EMPTY_COMPLETENESS,
  };
  return r;
}

const one = (ts: readonly number[], vs: readonly number[]) =>
  fixture([{ labels: { __name__: 'm' }, values: vs }], ts);
const two = () =>
  fixture(
    [
      { labels: { job: 'a' }, values: [1, 2, 3] },
      { labels: { job: 'b' }, values: [4, 5, 6] },
    ],
    [0, 5000, 10_000],
  );

const NO = { histogram: false, rateApplied: false };
const S = { histogram: true, rateApplied: false };

describe('unit:autovis-table', () => {
  it('rule 5: a bucket result with the histogram flag is a heatmap', () => {
    expect(autoVis({ ...S, result: fromRange(range(H1())) })).toEqual({ vis: 'heatmap', rule: 5 });
  });

  it('5 needs le: series without le fall through to line', () => {
    expect(autoVis({ ...S, result: fromRange(range(two())) })).toEqual({ vis: 'line', rule: 14 });
  });

  it('rule 6: a rate the page applied is a line', () => {
    expect(
      autoVis({ histogram: false, rateApplied: true, result: fromRange(range(two())) }),
    ).toEqual({ vis: 'line', rule: 6 });
  });

  it('5 before 6', () => {
    expect(autoVis({ histogram: true, rateApplied: true, result: fromRange(range(H1())) })).toEqual(
      { vis: 'heatmap', rule: 5 },
    );
  });

  it('rule 7: a scalar, or an instant result of one series with one point, is a stat', () => {
    const s1: InstantResult = {
      planned: PLANNED,
      kind: 'scalar',
      scalar: { value: Infinity, timestampMs: 0 },
      atMs: 0,
      completeness: EMPTY_COMPLETENESS,
    };
    const s2 = instant(one([0], [4]));
    const s3 = instant(one([0], [N]));
    for (const r of [s1, s2, s3]) {
      expect(autoVis({ ...S, result: fromInstant(r) })).toEqual({ vis: 'stat', rule: 7 });
    }
  });

  it('a range result is never a stat; nor an instant result of 0, 2 series or 3 points', () => {
    const results: ExploreResult[] = [
      fromRange(range(one([0, 5000, 10_000], [N, 4, N]))),
      fromRange(range(one([0], [4]))),
      fromRange(range(one([0, 5000, 10_000], [N, N, N]))),
      fromRange(range([])),
      fromInstant(
        instant(
          fixture(
            [
              { labels: { job: 'a' }, values: [1] },
              { labels: { job: 'b' }, values: [2] },
            ],
            [0],
          ),
        ),
      ),
      fromInstant(instant(one([0, 5000, 10_000], [1, 2, 3]), 'matrix')),
    ];
    results.forEach((result, i) => {
      expect(autoVis({ ...S, result }), `L${String(i + 1)}`).toEqual({ vis: 'line', rule: 14 });
    });
  });

  it('override: the vis parameter wins; auto takes the rule; a string has no vis', () => {
    expect(chooseVis('bars', { vis: 'heatmap', rule: 5 })).toBe('bars');
    expect(chooseVis('auto', { vis: 'heatmap', rule: 5 })).toBe('heatmap');
    const str: InstantResult = {
      planned: PLANNED,
      kind: 'string',
      value: 'x',
      timestampMs: 0,
      atMs: 0,
      completeness: EMPTY_COMPLETENESS,
    };
    expect(autoVis({ ...NO, result: fromInstant(str) })).toEqual({ vis: null, rule: null });
  });

  it('result adapters', () => {
    const r = fromRange(range(two(), 5000));
    expect(r).toMatchObject({ kind: 'series', source: 'range', stepMs: 5000 });
    expect(r.kind === 'series' ? r.series : []).toHaveLength(2);
    expect(fromInstant(instant(two()))).toMatchObject({
      kind: 'series',
      source: 'instant',
      stepMs: null,
    });
    expect(
      fromInstant({
        planned: PLANNED,
        kind: 'scalar',
        scalar: { value: 1, timestampMs: 2 },
        atMs: 2,
        completeness: EMPTY_COMPLETENESS,
      }),
    ).toEqual({
      kind: 'scalar',
      scalar: { value: 1, timestampMs: 2 },
      completeness: EMPTY_COMPLETENESS,
    });
    expect(
      fromInstant({
        planned: PLANNED,
        kind: 'string',
        value: 's',
        timestampMs: 2,
        atMs: 2,
        completeness: EMPTY_COMPLETENESS,
      }),
    ).toEqual({ kind: 'string', value: 's', completeness: EMPTY_COMPLETENESS });
  });
});

describe('unit:from-range-frame (plan #67)', () => {
  it('a volume result is a range frame', () => {
    const T0 = 1767225600000;
    const lvl = (l: string, v: number): SeriesFrame => ({
      key: l,
      labels: { level: l },
      timestamps: Float64Array.of(T0),
      values: Float64Array.of(v),
    });
    const VOL: VolumeResult = {
      startMs: T0,
      endMs: T0 + 3_600_000,
      stepMs: 1000,
      series: [lvl('error', 3), lvl('info', 5)],
      completeness: EMPTY_COMPLETENESS,
      planned: { query: '{app="x"}', expanded: '{app="x"}', bytes: 9, stepMs: 1000 },
    };
    expect(fromRange(VOL)).toEqual({
      kind: 'series',
      source: 'range',
      series: VOL.series,
      stepMs: 1000,
      completeness: EMPTY_COMPLETENESS,
    });
  });
});
