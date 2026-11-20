import { describe, expect, it } from 'vitest';
import { bucketScale, type BucketScale } from './bucketScale';

const PLOT = { x: 0, y: 0, width: 100, height: 300 };
const LABEL = 14;
const height = (s: BucketScale, i: number): number => {
  const r = s.rows[i];
  if (r === undefined) throw new Error(`no row ${String(i)}`);
  return r.y0 - r.y1;
};
const scale = (b: number[]): BucketScale => bucketScale(new Float64Array(b), PLOT, LABEL);
const finite = (s: BucketScale): boolean =>
  s.rows.every((r) => [r.lower, r.upper, r.y0, r.y1].every(Number.isFinite)) &&
  s.ticks.every((t) => Number.isFinite(t) && Number.isFinite(s.y(t)));

describe('unit:bucket-scale', () => {
  it('places the gallery buckets on a log scale with a +Inf band', () => {
    const s = scale([0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, Infinity]);
    expect(s.kind).toBe('log');
    expect(s.infBand).toEqual({ y0: 0, y1: 25 });
    expect(s.rows).toHaveLength(11);
    expect(
      Math.abs(height(s, 7) - (height(s, 8) * Math.log(2)) / Math.log(2.5)),
    ).toBeLessThanOrEqual(0.5);
    expect(s.rows[0]?.lower).toBeCloseTo(0.0025, 12);
    expect(s.rows[0]?.y0).toBeCloseTo(300, 9);
    expect(s.rows[10]?.y1).toBeCloseTo(27, 9);
    for (const t of [0.01, 0.1, 1, 10]) expect(s.ticks).toContain(t);
    expect(finite(s)).toBe(true);
  });

  it('places [1, 2, 4, 8] linearly from 0', () => {
    const s = scale([1, 2, 4, 8]);
    expect(s.kind).toBe('linear');
    expect(s.infBand).toBeNull();
    expect(Math.abs(height(s, 3) - 2 * height(s, 2))).toBeLessThanOrEqual(0.5);
    expect(s.rows[0]?.lower).toBe(0);
    expect(s.rows[0]?.y0).toBe(300);
  });

  it('widens [0, +Inf] to [-1, 0]', () => {
    const s = scale([0, Infinity]);
    expect(s.kind).toBe('linear');
    expect(s.infBand).toEqual({ y0: 0, y1: 150 });
    expect(s.rows).toEqual([{ lower: -1, upper: 0, y0: 300, y1: 152 }]);
    expect(s.ticks).toEqual([0]);
    expect(s.y(0)).toBe(152);
    expect(finite(s)).toBe(true);
  });

  it('starts [5, +Inf] at 0', () => {
    const s = scale([5, Infinity]);
    expect(s.rows).toEqual([{ lower: 0, upper: 5, y0: 300, y1: 152 }]);
    expect(s.ticks.length).toBeGreaterThan(0);
    for (const t of s.ticks) {
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(5);
    }
  });

  // r4-1: a first bound ≤ 0 with more finite bounds gets one bucket width below it.
  it('gives the first bucket of [0, 5, +Inf] a height', () => {
    const s = scale([0, 5, Infinity]);
    expect(s.kind).toBe('linear');
    expect(s.infBand).toEqual({ y0: 0, y1: 100 });
    expect(s.rows).toEqual([
      { lower: -5, upper: 0, y0: 300, y1: 201 },
      { lower: 0, upper: 5, y0: 201, y1: 102 },
    ]);
    expect(height(s, 0)).toBeGreaterThan(0);
    expect(finite(s)).toBe(true);
  });

  it('gives the first bucket of [-5, -1, +Inf] a height', () => {
    const s = scale([-5, -1, Infinity]);
    expect(s.kind).toBe('linear');
    expect(s.rows).toEqual([
      { lower: -9, upper: -5, y0: 300, y1: 201 },
      { lower: -5, upper: -1, y0: 201, y1: 102 },
    ]);
    expect(height(s, 0)).toBeGreaterThan(0);
    for (const t of s.ticks) {
      expect(t).toBeGreaterThanOrEqual(-9);
      expect(t).toBeLessThanOrEqual(-1);
    }
    expect(finite(s)).toBe(true);
  });
});
