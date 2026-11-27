import { describe, expect, it } from 'vitest';
import { fn, gridResult } from '../test/rangeApi';
import { bucketLastMs, bucketOf, bucketStartMs } from './buckets';
import type { RangeResult } from './decode';
import { fillRange, type StepSource } from './rangeFill';

const series = [fn({ a: '1' }, (t) => t / 1e6)];

/** Every bucket of `step` that meets [fromMs, toMs], each its own one-bucket result. */
function source(stepMs: number, fromMs: number, toMs: number): StepSource {
  const buckets = new Map<number, RangeResult>();
  for (let k = bucketOf(fromMs, stepMs); k <= bucketOf(toMs, stepMs); k++) {
    buckets.set(
      k,
      gridResult(
        { startMs: bucketStartMs(k, stepMs), endMs: bucketLastMs(k, stepMs), stepMs },
        'up',
        { series },
      ),
    );
  }
  return { stepMs, buckets };
}

const own = (stepMs: number, ks: readonly number[]) =>
  new Map(
    ks.map((k) => [
      k,
      source(stepMs, bucketStartMs(k, stepMs), bucketLastMs(k, stepMs)).buckets.get(
        k,
      ) as RangeResult,
    ]),
  );

describe('rangeFill (#304 Part B §4.2)', () => {
  const V = 60_000;
  const from = bucketStartMs(10, V);
  const to = bucketLastMs(13, V);

  it('fill nearest ratio', () => {
    const f = fillRange({
      stepMs: V,
      k0: 10,
      k1: 14,
      own: new Map(),
      others: [source(15_000, from, to), source(120_000, from, to)],
    });
    expect(f.rank).toBe(0);
    expect(f.sources).toEqual([120_000]);
    const ts = f.result.series[0]?.timestamps ?? new Float64Array(0);
    expect(Array.from(ts).every((t) => t % 120_000 === 0)).toBe(true);
  });

  it('fill tie finer', () => {
    const f = fillRange({
      stepMs: V,
      k0: 10,
      k1: 14,
      own: new Map(),
      others: [source(120_000, from, to), source(30_000, from, to)],
    });
    expect(f.sources).toEqual([30_000]);
  });

  it('fill union ts', () => {
    const f = fillRange({
      stepMs: V,
      k0: 10,
      k1: 14,
      own: own(V, [10, 11]),
      others: [source(60_000 * 2, bucketStartMs(12, V), to)],
    });
    const ts = Array.from(f.result.series[0]?.timestamps ?? []);
    expect(ts.slice(0, 512)).toEqual(
      Array.from({ length: 512 }, (_, i) => bucketStartMs(10, V) + i * V),
    );
    expect(ts.slice(512).every((t) => t >= bucketStartMs(12, V) && t % 120_000 === 0)).toBe(true);
    expect(ts.slice(512).length).toBeGreaterThan(0);
    for (let i = 1; i < ts.length; i++) expect(ts[i]).toBeGreaterThan(ts[i - 1] ?? Infinity);
    expect(f.rank).toBe(0);
  });

  it('no fill, gap', () => {
    const f = fillRange({
      stepMs: V,
      k0: 10,
      k1: 14,
      own: own(V, [10, 11, 13]),
      others: [],
    });
    expect(f.rank).toBe(0);
    expect(f.sources).toEqual([null]);
    const s = f.result.series[0];
    const ts = Array.from(s?.timestamps ?? []);
    const lo = bucketStartMs(12, V);
    const hi = bucketLastMs(12, V);
    const inGap = ts.map((t, i) => [t, s?.values[i]] as const).filter(([t]) => t >= lo && t <= hi);
    expect(inGap).toHaveLength(256);
    expect(inGap.every(([, v]) => Number.isNaN(v))).toBe(true);
  });

  it('a full own set is rank 1', () => {
    const f = fillRange({ stepMs: V, k0: 10, k1: 12, own: own(V, [10, 11]), others: [] });
    expect(f.rank).toBe(1);
    expect(f.sources).toEqual([]);
  });
});
