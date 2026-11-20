import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../test/random';
import { valueTicks } from './valueTicks';

const LABEL = 14;

describe('unit:ticks-prop value', () => {
  it('holds for 400 random domains, heights and bases', () => {
    const r = mulberry32(59);
    const magnitude = (): number => {
      const m = Math.exp(Math.log(1e-3) + r() * (Math.log(1e12) - Math.log(1e-3)));
      return r() < 0.3 ? -m : m;
    };
    for (let i = 0; i < 400; i++) {
      const a = magnitude();
      const b = magnitude();
      const dataMin = Math.min(a, b);
      const dataMax = Math.max(a, b);
      const height = 40 + r() * 1_960;
      const base = r() < 0.5 ? 1000 : 1024;
      const lo = Math.min(0, dataMin);
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
