import { describe, expect, it } from 'vitest';
import { validateFrameData, type FrameData, type SeriesFrame } from '../data/frames';
import type { VisKind, VisSpec } from '../engine/api';
import { toggleIsolation } from '../explore/seriesRows';
import {
  arr,
  EMPTY_COMPLETENESS,
  fixture,
  fkey,
  G2,
  G3,
  H1,
  J6,
  N,
} from '../test/histogramFixtures';
import type { ExploreResult } from './autovis';
import { canIsolate, framePlan, SCALAR_KEY, type FramePlan } from './framePlan';

const I = Infinity;
const NONE = { kind: 'none' } as const;
const PS = { kind: 'suffix', suffix: '/s' } as const;

const ranged = (series: readonly SeriesFrame[]): ExploreResult => ({
  kind: 'series',
  source: 'range',
  series,
  stepMs: 5000,
  completeness: EMPTY_COMPLETENESS,
});
const S = { value: 7, timestampMs: 3_600_000 };
const scalar: ExploreResult = { kind: 'scalar', scalar: S, completeness: EMPTY_COMPLETENESS };
const str: ExploreResult = { kind: 'string', value: 's', completeness: EMPTY_COMPLETENESS };
const two = () =>
  fixture([
    { labels: { job: 'a' }, values: [1, 2] },
    { labels: { job: 'b' }, values: [3, 4] },
  ]);
const B = () => ranged(H1());

const plan = (
  vis: VisKind,
  r: ExploreResult,
  o: { isolatedKey?: string | null; rateApplied?: boolean } = {},
): FramePlan =>
  framePlan(vis, r, {
    isolatedKey: o.isolatedKey ?? null,
    title: 'T',
    rateApplied: o.rateApplied ?? false,
  });

/** The plan with Float64Arrays as plain arrays (NaN compares equal), after the validity check. */
function plain(p: FramePlan) {
  if (p.spec !== null && p.data !== null) expect(validateFrameData(p.spec, p.data)).toBeNull();
  return { spec: p.spec, data: p.data === null ? null : plainData(p.data), notice: p.notice };
}
function plainData(d: FrameData) {
  switch (d.kind) {
    case 'series':
      return {
        kind: d.kind,
        series: d.series.map((s) => ({
          ...s,
          timestamps: arr(s.timestamps),
          values: arr(s.values),
        })),
      };
    case 'heatmap':
      return {
        kind: d.kind,
        heatmap: {
          timestamps: arr(d.heatmap.timestamps),
          bounds: arr(d.heatmap.bounds),
          counts: arr(d.heatmap.counts),
        },
      };
    case 'scalar':
      return d;
  }
}
const seriesOf = (s: readonly SeriesFrame[]) => plainData({ kind: 'series', series: s });
const heat = (bounds: number[], counts: number[], ts = [0, 5000]) => ({
  kind: 'heatmap',
  heatmap: { timestamps: ts, bounds, counts },
});

const LINE = (unit: VisSpec['unit']): VisSpec => ({ kind: 'line', title: 'T', unit });
const BARS = (unit: VisSpec['unit']): VisSpec => ({
  kind: 'bars',
  title: 'T',
  unit,
  stacking: 'normal',
  categoryLabel: '',
  categoryOrder: [],
});
const HEAT = (countUnit: VisSpec['unit']): VisSpec => ({
  kind: 'heatmap',
  title: 'T',
  unit: NONE,
  countUnit,
});
const H1_FULL = heat([0.1, 1, I], [1, 2, 1, 2, 3, 0]);

describe('unit:frame-plan', () => {
  it('series: F1, F2, F4–F7', () => {
    expect(plain(plan('line', ranged(two()), { rateApplied: true }))).toEqual({
      spec: LINE(PS),
      data: seriesOf(two()),
      notice: null,
    });
    expect(plain(plan('bars', ranged(two())))).toEqual({
      spec: BARS(NONE),
      data: seriesOf(two()),
      notice: null,
    });
    expect(plain(plan('heatmap', B(), { rateApplied: true }))).toEqual({
      spec: HEAT(PS),
      data: H1_FULL,
      notice: null,
    });
    expect(plain(plan('heatmap', ranged(two())))).toEqual({
      spec: HEAT(NONE),
      data: null,
      notice: 'noBuckets',
    });
    expect(plain(plan('line', str))).toEqual({ spec: null, data: null, notice: 'string' });
    expect(plain(plan('line', ranged(two()), { isolatedKey: 'ffffffffffffffff' }))).toEqual({
      spec: LINE(NONE),
      data: seriesOf(two()),
      notice: null,
    });
  });

  it('bars over instant series with unequal timestamps grids them, keeping gaps', () => {
    const at = (key: string, job: string, ts: number[], vs: number[]): SeriesFrame => ({
      key,
      labels: { job },
      timestamps: new Float64Array(ts),
      values: new Float64Array(vs),
    });
    const instant: ExploreResult = {
      kind: 'series',
      source: 'instant',
      series: [at(fkey(0), 'a', [1000, 3000], [1, 3]), at(fkey(1), 'b', [2000], [2])],
      stepMs: null,
      completeness: EMPTY_COMPLETENESS,
    };
    const p = plan('bars', instant);
    expect(p.spec === null || p.data === null ? 'none' : validateFrameData(p.spec, p.data)).toBe(
      null,
    );
    expect(plain(p)).toEqual({
      spec: BARS(NONE),
      data: seriesOf([
        at(fkey(0), 'a', [1000, 2000, 3000], [1, N, 3]),
        at(fkey(1), 'b', [1000, 2000, 3000], [N, 2, N]),
      ]),
      notice: null,
    });
    // Isolating one series keeps it as it is; line keeps each series' own timestamps.
    expect(plain(plan('bars', instant, { isolatedKey: fkey(1) })).data).toEqual(
      seriesOf([at(fkey(1), 'b', [2000], [2])]),
    );
    expect(plain(plan('line', instant)).data).toEqual(seriesOf(instant.series));
  });

  it('scalar overrides: SC1–SC4', () => {
    const lone = seriesOf([
      {
        key: SCALAR_KEY,
        labels: {},
        timestamps: Float64Array.of(3_600_000),
        values: Float64Array.of(7),
      },
    ]);
    expect(plain(plan('stat', scalar))).toEqual({
      spec: { kind: 'stat', title: 'T', unit: NONE },
      data: { kind: 'scalar', scalar: S },
      notice: null,
    });
    expect(plain(plan('line', scalar))).toEqual({ spec: LINE(NONE), data: lone, notice: null });
    expect(plain(plan('bars', scalar))).toEqual({ spec: BARS(NONE), data: lone, notice: null });
    const sc4 = plan('heatmap', scalar);
    expect(plain(sc4)).toEqual({ spec: HEAT(NONE), data: null, notice: 'noBuckets' });
    expect(sc4.spec).toHaveProperty('countUnit');
  });

  it('heatmap isolation: I0–I10', () => {
    const full = { spec: HEAT(NONE), data: H1_FULL, notice: null };
    const row = (counts: number[], bounds = [0.1, 1, I]) => ({
      spec: HEAT(NONE),
      data: heat(bounds, counts),
      notice: null,
    });
    expect(plain(plan('heatmap', B()))).toEqual(full);
    expect(plain(plan('heatmap', B(), { isolatedKey: fkey(1) }))).toEqual(row([N, 2, N, N, 3, N]));
    expect(plain(plan('heatmap', B(), { isolatedKey: fkey(2) }))).toEqual(row([N, N, 1, N, N, 0]));
    expect(plain(plan('heatmap', B(), { isolatedKey: fkey(0) }))).toEqual(row([1, N, N, 2, N, N]));
    expect(plain(plan('heatmap', B(), { isolatedKey: 'ffffffffffffffff' }))).toEqual(full);
    expect(plain(plan('heatmap', ranged(G2()), { isolatedKey: fkey(1) }))).toEqual(
      row([N, 1, N, N, 2, N]),
    );
    expect(plain(plan('heatmap', ranged(G2()), { isolatedKey: fkey(5) }))).toEqual(
      row([N, N, 4, N, N, 4]),
    );
    expect(plain(plan('heatmap', ranged(J6()), { isolatedKey: fkey(2) }))).toEqual(
      row([N, N, N, N], [0.1, I]),
    );
    expect(plain(plan('line', B(), { isolatedKey: fkey(1) }))).toEqual({
      spec: LINE(NONE),
      data: seriesOf(H1().slice(1, 2)),
      notice: null,
    });
    const i8 = plan('line', B(), { isolatedKey: fkey(1) });
    expect(
      i8.data?.kind === 'series' ? arr(i8.data.series[0]?.values ?? new Float64Array()) : [],
    ).toEqual([3, 5]);
    expect(plain(plan('heatmap', ranged(G3()), { isolatedKey: fkey(3) }))).toEqual(
      row([N, N, N, N, N, N], [1, 2, I]),
    );
    expect([
      canIsolate('heatmap', B()),
      canIsolate('heatmap', ranged(two())),
      canIsolate('line', B()),
      canIsolate('line', scalar),
      canIsolate(null, B()),
    ]).toEqual([true, false, true, false, false]);
  });

  it('click again restores the full view', () => {
    const k = toggleIsolation(null, fkey(1));
    expect(k).toBe(fkey(1));
    const p1 = plan('heatmap', B(), { isolatedKey: k });
    expect(plain(p1)).toEqual(plain(plan('heatmap', B(), { isolatedKey: fkey(1) })));
    expect(plain(p1).data).toEqual(heat([0.1, 1, I], [N, 2, N, N, 3, N]));
    const k2 = toggleIsolation(k, fkey(1));
    expect(k2).toBeNull();
    expect(plain(plan('heatmap', B(), { isolatedKey: k2 }))).toEqual(plain(plan('heatmap', B())));
    expect(plain(plan('heatmap', B(), { isolatedKey: k2 })).data).toEqual(H1_FULL);
    expect(toggleIsolation(k, fkey(0))).toBe(fkey(0));
  });
});
