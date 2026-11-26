import { describe, expect, it } from 'vitest';
import { percentiles, summarise } from './benchStats.ts';

describe('benchStats (plan #68 C2d1 §3.1)', () => {
  it('percentiles: nearest rank on the sorted copy', () => {
    const empty = percentiles([]);
    expect([empty.p50, empty.p95, empty.p99, empty.max].every(Number.isNaN)).toBe(true);
    expect(percentiles([5])).toEqual({ p50: 5, p95: 5, p99: 5, max: 5 });
    const hundred = Array.from({ length: 100 }, (_, i) => 100 - i);
    expect(percentiles(hundred)).toEqual({ p50: 50, p95: 95, p99: 99, max: 100 });
    const xs = [3, 1, 2];
    expect(percentiles(xs).p50).toBe(2);
    expect(xs).toEqual([3, 1, 2]);
  });

  it('summarise: intervals between marks inside the span, missed frames, draw times', () => {
    const c = {
      gate: 'bench:frame-gallery',
      case: 'line-50',
      leg: 'wasm-webgl2',
      points: 72_000,
      series: 50,
    } as const;
    const r = summarise(
      c,
      [-40, 0, 16, 33, 100],
      [
        { start: 0, end: 2 },
        { start: 14, end: 17 },
        { start: 29, end: 33 },
        { start: 95, end: 100 },
      ],
      { start: -1, end: 200 },
    );
    expect(r).toMatchObject(c);
    expect(r.frames).toBe(4);
    expect(r.intervalMs).toEqual(percentiles([16, 17, 67]));
    expect(r.intervalMs.max).toBe(67);
    expect(r.intervalMs.p50).toBe(17);
    expect(r.over1).toBe(2);
    expect(r.over2).toBe(1);
    expect(r.drawMs.max).toBe(5);
    expect(r.drawMs.p50).toBe(3);
    expect(r.skipped).toBeUndefined();
  });
});
