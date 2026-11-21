import { describe, expect, it } from 'vitest';
import type { HeatmapFrame, SeriesFrame } from '../data/frames';
import { arr, fixture, fkey, G2, G3, H1, J6, le, N } from '../test/histogramFixtures';
import { histogramBuckets, isHistogram, isolateBucket } from './histogram';

const I = Infinity;

function plain(h: HeatmapFrame | null) {
  return h === null
    ? null
    : { timestamps: arr(h.timestamps), bounds: arr(h.bounds), counts: arr(h.counts) };
}

const expectFrame = (
  h: HeatmapFrame | null,
  bounds: number[],
  counts: number[],
  ts = [0, 5000],
) => {
  expect(plain(h)).toEqual({ timestamps: ts, bounds, counts });
};

describe('unit:heatmap-buckets', () => {
  it('complete: H1–H4', () => {
    expectFrame(histogramBuckets(H1()), [0.1, 1, I], [1, 2, 1, 2, 3, 0]);
    const h2 = fixture([le('+Inf', [4, 5]), le('0.1', [1, 2]), le('1', [3, 5])]);
    expectFrame(histogramBuckets(h2), [0.1, 1, I], [1, 2, 1, 2, 3, 0]);
    const h3 = fixture([le('1', [1, 1]), le('1', [2, 2]), le('+Inf', [3, 3]), le('+Inf', [4, 4])]);
    expectFrame(histogramBuckets(h3), [1, I], [3, 4, 3, 4]);
    const h4 = fixture([le('1', [5]), le('+Inf', [4])], [0]);
    expectFrame(histogramBuckets(h4), [1, I], [5, 0], [0]);
  });

  it('H9: no le, unequal timestamps, only +Inf, a bad le → null', () => {
    const noLe = fixture([le('1', [1, 1]), { labels: { job: 'a' }, values: [1, 1] }]);
    const unequal: SeriesFrame[] = [
      ...fixture([le('1', [1, 1])]),
      ...fixture([le('+Inf', [1, 1])], [0, 6000]).map((s) => ({ ...s, key: fkey(1) })),
    ];
    const onlyInf = fixture([le('+Inf', [1, 1]), le('Inf', [2, 2], { job: 'b' })]);
    const bad = fixture([le('1', [1, 1]), le('abc', [1, 1])]);
    for (const s of [noLe, unequal, onlyInf, bad]) expect(histogramBuckets(s)).toBeNull();
  });

  it('missing single: H5, H6, H8', () => {
    const h5 = histogramBuckets(fixture([le('1', [N, 2]), le('+Inf', [1, 3])]));
    expectFrame(h5, [1, I], [N, N, 2, 1]);
    expect(
      arr(h5?.counts ?? new Float64Array())
        .slice(0, 2)
        .some((c) => c === 0),
    ).toBe(false);
    const h6 = fixture([le('0.1', [1, 2]), le('1', [3, N]), le('+Inf', [4, 5])]);
    expectFrame(histogramBuckets(h6), [0.1, 1, I], [1, 2, 1, 2, N, N]);
    const h8 = fixture([le('1', [I, 1]), le('+Inf', [5, 2])]);
    expectFrame(histogramBuckets(h8), [1, I], [N, N, 1, 1]);
  });

  it('missing grouped: H7a, H7b (a partial sum is not used)', () => {
    const h7a = fixture([le('1', [1, 1]), le('1', [2, N]), le('+Inf', [3, 3]), le('+Inf', [4, 4])]);
    expectFrame(histogramBuckets(h7a), [1, I], [3, 4, N, N]);
    const h7b = fixture([le('1', [N, 1]), le('1', [N, 2]), le('+Inf', [3, 3]), le('+Inf', [4, 4])]);
    expectFrame(histogramBuckets(h7b), [1, I], [N, N, 3, 4]);
  });

  it('grouped full view: G2, G2m, G3, G4, G5, J6', () => {
    expectFrame(histogramBuckets(G2()), [0.1, 1, I], [1, 2, 4, 2, 2, 5]);
    const g2m = G2().map((s, i) => (i === 1 ? { ...s, values: new Float64Array([2, N]) } : s));
    expectFrame(histogramBuckets(g2m), [0.1, 1, I], [1, 2, 4, 2, N, N]);
    expectFrame(histogramBuckets(G3()), [1, 2, I], [N, N, N, N, N, N]);
    expectFrame(histogramBuckets(G3().slice(0, 5)), [1, 2, I], [N, N, 6, N, N, 7]);
    const g5 = fixture(
      [
        le('1', [5], { job: 'a' }),
        le('+Inf', [4], { job: 'a' }),
        le('1', [1], { job: 'b' }),
        le('+Inf', [3], { job: 'b' }),
      ],
      [0],
    );
    expectFrame(histogramBuckets(g5), [1, I], [6, 2], [0]);
    expectFrame(histogramBuckets(J6()), [0.1, I], [N, N, N, N]);
  });

  it('isolate: J1–J7 (bounds are always the full view’s)', () => {
    expectFrame(isolateBucket(H1(), fkey(1)), [0.1, 1, I], [N, 2, N, N, 3, N]);
    expectFrame(isolateBucket(H1(), fkey(2)), [0.1, 1, I], [N, N, 1, N, N, 0]);
    expectFrame(isolateBucket(H1(), 'ffffffffffffffff'), [0.1, 1, I], [1, 2, 1, 2, 3, 0]);
    expectFrame(isolateBucket(G2(), fkey(1)), [0.1, 1, I], [N, 1, N, N, 2, N]);
    expectFrame(isolateBucket(G2(), fkey(5)), [0.1, 1, I], [N, N, 4, N, N, 4]);
    expectFrame(isolateBucket(J6(), fkey(2)), [0.1, I], [N, N, N, N]);
    const h5 = fixture([le('1', [N, 2]), le('+Inf', [1, 3])]);
    expectFrame(isolateBucket(h5, fkey(1)), [1, I], [N, N, N, 1]);
  });

  it('isolate: J8–J12 (G3: the full view’s interval from the row’s group)', () => {
    const b = [1, 2, I];
    expectFrame(isolateBucket(G3(), fkey(3)), b, [N, N, N, N, N, N]);
    expectFrame(isolateBucket(G3(), fkey(4)), b, [N, N, 3, N, N, 5]);
    expectFrame(isolateBucket(G3(), fkey(5)), b, [1, N, N, 1, N, N]);
    expectFrame(isolateBucket(G3(), fkey(6)), b, [N, N, N, N, N, N]);
    expectFrame(isolateBucket(G3(), fkey(0)), b, [1, N, N, 2, N, N]);
    expectFrame(isolateBucket(G3(), fkey(1)), b, [N, 2, N, N, 2, N]);
  });
});

/**
 * Many groups over many distinct bounds: each group `{job: g}` has its own finite bound and
 * `+Inf`, so the full view has `groups + 1` bounds but each group only two. The work must scale with
 * the input and the output, not with groups × timestamps × bounds (review r1 #2).
 */
function sparseGroups(groups: number, nt: number): SeriesFrame[] {
  const timestamps = new Float64Array(nt).map((_, t) => t * 1000);
  const out: SeriesFrame[] = [];
  for (let g = 0; g < groups; g++) {
    for (const [bound, v] of [
      [String(g + 1), 1],
      ['+Inf', 2],
    ] as const) {
      out.push({
        key: fkey(out.length),
        labels: { job: `j${g}`, le: bound },
        timestamps,
        values: new Float64Array(nt).fill(v),
      });
    }
  }
  return out;
}

/** Many complete groups on the same bounds: every interval of every group counts 1. */
function denseGroups(groups: number, bounds: number, nt: number): SeriesFrame[] {
  const timestamps = new Float64Array(nt).map((_, t) => t * 1000);
  const out: SeriesFrame[] = [];
  for (let g = 0; g < groups; g++) {
    for (let b = 0; b < bounds; b++) {
      out.push({
        key: fkey(out.length),
        labels: { job: `j${g}`, le: b === bounds - 1 ? '+Inf' : String(b + 1) },
        timestamps,
        values: new Float64Array(nt).fill(b + 1),
      });
    }
  }
  return out;
}

const timed = <T>(f: () => T): [T, number] => {
  const t0 = performance.now();
  const v = f();
  return [v, performance.now() - t0];
};

describe('unit:heatmap-buckets scale', () => {
  it('many groups × many bounds: linear in input and output', () => {
    const groups = 400;
    const nt = 1000;
    const s = sparseGroups(groups, nt);
    const [eligible, tEligible] = timed(() => isHistogram(s));
    expect(eligible).toBe(true);
    const [h, tFull] = timed(() => histogramBuckets(s));
    const [iso, tIso] = timed(() => isolateBucket(s, fkey(1)));
    expect(h?.bounds.length).toBe(groups + 1);
    expect(h?.counts.length).toBe(nt * (groups + 1));
    // Every group lacks every other group's bound: no cell is invented (T02 §4.4).
    expect(h?.counts.every((c) => Number.isNaN(c))).toBe(true);
    expect(iso?.counts.every((c) => Number.isNaN(c))).toBe(true);
    // The old per-group grid takes seconds here (~0.4 G cells allocated and scanned 3×).
    expect({ tEligible: tEligible < 100, tFull: tFull < 400, tIso: tIso < 100 }).toEqual({
      tEligible: true,
      tFull: true,
      tIso: true,
    });
  });

  it('many complete groups: every interval sums over the groups', () => {
    const groups = 50;
    const bounds = 20;
    const nt = 200;
    const h = histogramBuckets(denseGroups(groups, bounds, nt));
    expect(h?.bounds.length).toBe(bounds);
    expect(h?.counts.every((c) => c === groups)).toBe(true);
  });
});
