import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../test/random';
import {
  extremeTicks,
  nearerZero,
  niceValueTicks,
  tickY,
  ticksFit,
  valueFraction,
  valueTicks,
} from './valueTicks';

const LABEL = 14;
const M = Number.MAX_VALUE;
const MIN3 = 3 * Number.MIN_VALUE;

/** The seed-59 `unit:ticks-prop` generator: [lo, dataMax, height, base] per case. */
function propCases(): [number, number, number, 1000 | 1024][] {
  const r = mulberry32(59);
  const magnitude = (): number => {
    const m = Math.exp(Math.log(1e-3) + r() * (Math.log(1e12) - Math.log(1e-3)));
    return r() < 0.3 ? -m : m;
  };
  const out: [number, number, number, 1000 | 1024][] = [];
  for (let i = 0; i < 400; i++) {
    const a = magnitude();
    const b = magnitude();
    const height = 40 + r() * 1_960;
    const base = r() < 0.5 ? 1000 : 1024;
    out.push([Math.min(0, Math.min(a, b)), Math.max(a, b), height, base]);
  }
  return out;
}

describe('unit:ticks-prop value', () => {
  it('holds for 400 random domains, heights and bases', () => {
    for (const [i, [lo, dataMax, height, base]] of propCases().entries()) {
      const v = valueTicks(lo, dataMax, height, LABEL, base);
      const what = `case ${String(i)}: [${String(lo)}, ${String(dataMax)}] h ${String(height)} base ${String(base)}`;
      expect(v.ticks.length, what).toBeGreaterThanOrEqual(2);
      for (let k = 1; k < v.ticks.length; k++) {
        expect(v.ticks[k] ?? 0, what).toBeGreaterThan(v.ticks[k - 1] ?? 0);
      }
      expect(v.min, what).toBeLessThanOrEqual(lo);
      expect(v.max, what).toBeGreaterThanOrEqual(dataMax);
      if (height >= 42) {
        const spacing = (height * ((v.ticks[1] ?? 0) - (v.ticks[0] ?? 0))) / (v.max - v.min);
        expect(spacing, what).toBeGreaterThanOrEqual(LABEL + 2 - 1e-6);
      }
    }
  });

  it('widens an empty domain to [0, 1]', () => {
    const v = valueTicks(0, 0, 200, LABEL, 1000);
    expect([v.min, v.max]).toEqual([0, 1]);
  });
});

const ticksOf = (v: { readonly ticks: readonly number[] }): number[] => [...v.ticks];

describe('unit:value-ticks-bounded in-process (#97)', () => {
  it('B1: equal ends widen toward zero', () => {
    expect(extremeTicks(4, 4, 200, LABEL)).toEqual({ min: 2, max: 4, ticks: [2, 3, 4] });
    expect(extremeTicks(-4, -4, 200, LABEL)).toEqual({ min: -4, max: -2, ticks: [-4, -3, -2] });
    expect(extremeTicks(0, 0, 200, LABEL)).toEqual({ min: 0, max: 1, ticks: [0, 0.5, 1] });
  });

  it('B2: subnormal spans have no duplicate midpoint', () => {
    expect(ticksOf(extremeTicks(0, 5e-324, 200, LABEL))).toEqual([0, 5e-324]);
    expect(ticksOf(extremeTicks(5e-324, 1e-323, 200, LABEL))).toEqual([5e-324, 1e-323]);
  });

  it('B3: the fallback thins by the mapped gaps (3, 2, then 1 ticks)', () => {
    const sub = [32, 48, 47.5].map((h) => ticksOf(extremeTicks(0, MIN3, h, LABEL)));
    expect(sub).toEqual([
      [0, 1.5e-323],
      [0, 1e-323, 1.5e-323],
      [0, 1.5e-323],
    ]);
    const mid = [32, 31.9, 16, 15.9, NaN].map((h) => ticksOf(extremeTicks(-2, 6, h, LABEL)));
    expect(mid).toEqual([[-2, 2, 6], [-2, 6], [-2, 6], [-2], [-2]]);
    const max = [32, 31.5].map((h) => ticksOf(extremeTicks(-M, M, h, LABEL)));
    expect(max).toEqual([
      [-M, 0, M],
      [-M, M],
    ]);
  });

  it('B7: valueFraction is the draw mapping, halved when the span overflows', () => {
    expect(valueFraction(1e-323, 0, MIN3)).toBeCloseTo(2 / 3, 15);
    expect(valueFraction(0, -M, M)).toBe(0.5);
    expect(valueFraction(M, -M, M)).toBe(1);
    expect(valueFraction(3, 1, 5)).toBe(0.5);
  });

  it('B8: ticksFit measures the drawn gaps', () => {
    expect(ticksFit([-M, 0, M], -M, M, 200, LABEL)).toBe(true);
    const yMax = [-M, 0, M].map((v) => tickY(v, -M, M, 0, 200));
    expect(yMax).toEqual([200, 100, 0]);
    expect(yMax.every(Number.isFinite)).toBe(true);
    const sub = [0, 1e-323, 1.5e-323];
    expect(ticksFit(sub, 0, 1.5e-323, 48, LABEL)).toBe(true);
    const ySub = sub.map((v) => tickY(v, 0, 1.5e-323, 0, 48));
    expect(ySub).toEqual([48, 16, 0]);
    expect(ySub.every(Number.isFinite)).toBe(true);
    expect(ticksFit(sub, 0, 1.5e-323, 47.5, LABEL)).toBe(false);
    expect(ticksFit([1, 1, 1.00000000001], 0.9999999999999999, 1.00000000001, 200, LABEL)).toBe(
      false,
    );
    expect(ticksFit([0, 1], 0, 1, NaN, LABEL)).toBe(false);
    expect(ticksFit([5], 0, 10, 0, LABEL)).toBe(true);
  });

  it('B4: nearerZero keeps the smaller |v|, lo on a tie', () => {
    expect([nearerZero(-1, 1), nearerZero(-3, 1), nearerZero(2, 5), nearerZero(-5, -2)]).toEqual([
      -1, 1, 2, -2,
    ]);
  });

  it('B5: the nice search gives up outside its domain', () => {
    expect(niceValueTicks(-M, M, 200, LABEL, 1000)).toBeNull();
    expect(niceValueTicks(1e17, 1e17, 200, LABEL, 1000)).toBeNull();
    expect(niceValueTicks(0, 5e-324, 200, LABEL, 1000)).toBeNull();
    expect(niceValueTicks(-1.7e-6, 4e-6, 21, LABEL, 1024)).toBeNull();
    expect(niceValueTicks(NaN, 1, 200, LABEL, 1000)).toBeNull();
    expect(niceValueTicks(2, 1, 200, LABEL, 1000)).toBeNull();
  });

  it('B6: on the seed-59 domains valueTicks is the nice search, never the fallback', () => {
    for (const [i, [lo, hi, h, base]] of propCases().entries()) {
      const nice = niceValueTicks(lo, hi, h, LABEL, base);
      expect(nice, `case ${String(i)}`).not.toBeNull();
      expect(valueTicks(lo, hi, h, LABEL, base), `case ${String(i)}`).toEqual(nice);
    }
  });
});
