/**
 * `bench:range-stitch` (#304 §A.5), report-only and skipped unless `BENCH=1`: three segments of 5,
 * 4 and 5 buckets (1 280 + 1 024 + 1 280 = 3 584 points) stitched into one held span, 100 and 585
 * series (585 × 3 584 = 2 096 640 cells ≤ `HELD_CELLS`); 20 warm-up and 200 measured iterations.
 * Targets: p95 ≤ 4 ms and ≤ 25 ms; a breach is reported in the gate summary and opens the
 * follow-up "stitch in the render worker". `BENCH=1 npx vitest run src/data/rangeStore.bench.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { fn, gridResult } from '../test/rangeApi';
import { bucketLastMs, bucketStartMs } from './buckets';
import { stitch } from './rangeStitch';

const STEP = 15_000;
interface NodeLike {
  readonly env: Record<string, string | undefined>;
  readonly stderr: { write(s: string): void };
}
const node = (globalThis as { process?: NodeLike }).process;
const on = node?.env['BENCH'] === '1';

function parts(series: number) {
  const ss = Array.from({ length: series }, (_, i) => fn({ i: String(i) }, (t) => i + t / 1e9));
  const seg = (k0: number, k1: number) => ({
    k0,
    k1,
    result: gridResult(
      { startMs: bucketStartMs(k0, STEP), endMs: bucketLastMs(k1 - 1, STEP), stepMs: STEP },
      'up',
      { series: ss },
    ),
  });
  return [seg(100, 105), seg(105, 109), seg(109, 114)];
}

function measure(series: number): { p50: number; p95: number } {
  const ps = parts(series);
  for (let i = 0; i < 20; i++) stitch(ps, 100, 114, STEP);
  const t: number[] = [];
  for (let i = 0; i < 200; i++) {
    const t0 = performance.now();
    const r = stitch(ps, 100, 114, STEP);
    t.push(performance.now() - t0);
    expect(r.series[0]?.timestamps.length).toBe(3_584);
  }
  t.sort((a, b) => a - b);
  return { p50: t[100] ?? NaN, p95: t[190] ?? NaN };
}

describe.skipIf(!on)('bench:range-stitch', () => {
  it('reports p50 and p95', () => {
    for (const [series, target] of [
      [100, 4],
      [585, 25],
    ] as const) {
      const m = measure(series);
      node?.stderr.write(
        `bench:range-stitch ${String(series)} series × 3584 points: p50 ${m.p50.toFixed(2)} ms, p95 ${m.p95.toFixed(2)} ms (target ≤ ${String(target)} ms${m.p95 > target ? ', BREACH' : ''})\n`,
      );
    }
  }, 120_000);
});
