import { describe, expect, it } from 'vitest';
import { budgets, collectUntil, percentiles, summarise, type Drive } from './benchStats.ts';

const C = {
  gate: 'bench:frame-gallery',
  case: 'line-50',
  leg: 'wasm-webgl2',
  points: 72_000,
  series: 50,
} as const;

/** A fake page clock: `wait` advances it; presents at given times are seen once reached. */
function fakeClock(presentsAt: readonly number[]) {
  let t = 0;
  return {
    clock: {
      now: () => t,
      wait: (ms: number) => {
        t += Math.max(ms, 0);
        return Promise.resolve();
      },
    },
    presents: () => presentsAt.filter((p) => p <= t).length,
    seen: () => presentsAt.filter((p) => p <= t),
    advance: (ms: number) => {
      t += ms;
    },
    now: () => t,
  };
}

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
    const d: Drive = {
      presents: [-40, 0, 16, 33, 100],
      draws: [
        { start: 0, end: 2 },
        { start: 14, end: 17 },
        { start: 29, end: 33 },
        { start: 95, end: 100 },
      ],
      span: { start: -1, end: 200 },
      steps: 120,
      timedOut: false,
    };
    const r = summarise(C, d);
    expect(r).toMatchObject(C);
    expect(r.frames).toBe(4);
    expect(r.intervalMs).toEqual(percentiles([16, 17, 67]));
    expect(r.intervalMs.max).toBe(67);
    expect(r.intervalMs.p50).toBe(17);
    expect(r.over1).toBe(2);
    expect(r.over2).toBe(1);
    expect(r.drawMs.max).toBe(5);
    expect(r.drawMs.p50).toBe(3);
    expect(r.steps).toBe(120);
    expect(r.coalescing).toBe(30);
    expect(r.skipped).toBeUndefined();
    expect(r.timedOut).toBeUndefined();
  });

  it('slow presents: collection continues past the script until 2 presents, within the box', async () => {
    // 120 steps over 2 s and the settle wait; the engine presents at 3.1 s and 6.3 s.
    const run = async (boxMs: number) => {
      const f = fakeClock([3100, 6300]);
      f.advance(2000 + 500);
      const timedOut = await collectUntil(f.clock, f.presents, {
        start: 0,
        boxMs,
        min: 2,
        pollMs: 50,
      });
      return summarise(C, {
        presents: f.seen(),
        draws: [],
        span: { start: 0, end: f.now() },
        steps: 120,
        timedOut,
      });
    };
    const long = await run(120_000);
    expect(long.frames).toBe(2);
    expect(long.intervalMs.max).toBe(3200);
    expect(long.timedOut).toBeUndefined();
    const short = await run(4000);
    expect(short.frames).toBe(1);
    expect(short.timedOut).toBe(true);
  });

  it('empty percentiles: one present has no interval, null in the JSON and n/a budgets', () => {
    const r = summarise(C, {
      presents: [10],
      draws: [],
      span: { start: 0, end: 100 },
      steps: 120,
      timedOut: false,
    });
    const json = JSON.parse(JSON.stringify(r)) as typeof r;
    expect(json.intervalMs).toEqual({ p50: null, p95: null, p99: null, max: null });
    expect(budgets(r)).toEqual({ prf001: 'n/a', prf002: 'n/a' });
    expect(budgets(json)).toEqual({ prf001: 'n/a', prf002: 'n/a' });
    const ok = summarise(C, {
      presents: [0, 10, 20],
      draws: [],
      span: { start: 0, end: 100 },
      steps: 2,
      timedOut: false,
    });
    expect(budgets(ok)).toEqual({ prf001: 'ok', prf002: 'ok' });
    const over = summarise(C, {
      presents: [0, 40, 80],
      draws: [],
      span: { start: 0, end: 100 },
      steps: 2,
      timedOut: false,
    });
    expect(budgets(over)).toEqual({ prf001: 'over', prf002: 'over' });
  });
});
