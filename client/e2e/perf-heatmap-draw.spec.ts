/**
 * `bench:frame-interim-heatmap` (report only until #68; plan #63 §5): the Canvas 2D layer draw of
 * the M3 heatmap row, 10 000 columns × 200 buckets, with every 97th cell missing (NaN), into a
 * 1 200 × 400 `OffscreenCanvas`. No threshold on shared CI (T05-006); p50 and p95 are reported.
 * `HEATMAP_BENCH_NAN=0` draws the same fixture without missing cells (the before/after evidence of
 * a draw-path change records both runs).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { DEV_SERVER, NEEDS_BFF, PREVIEW } from './bff.ts';

const WARMUP = 10;
const SAMPLES = 50;
const withNaN = process.env['HEATMAP_BENCH_NAN'] !== '0';

function percentile(sorted: number[], p: number): number {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i] ?? 0;
}

test.describe('bench:frame-interim-heatmap', () => {
  test.skip(PREVIEW, NEEDS_BFF);

  test('bench:frame-interim-heatmap (report only)', async ({ page }, info) => {
    test.setTimeout(180_000);
    await page.goto(`${DEV_SERVER}/`);
    const result = await page.evaluate(
      async ({ warmup, samples, nan }) => {
        // Vite dev serves the sources by path; these are the engine's own modules. The paths are
        // built at run time so the e2e typecheck does not resolve them.
        const src = (path: string): Promise<unknown> => import(/* @vite-ignore */ `/src/${path}`);
        const draw = (await src('engine/canvas2d/draw.ts')) as {
          drawLayer: (i: unknown) => { summary: { kind: string } };
        };
        const palette = (await src('engine/canvas2d/palette.ts')) as {
          themeColours: (t: 'light' | 'dark') => unknown;
        };
        const synth = (await src('dev/synth.ts')) as {
          synthHeatmap: (o: unknown) => { counts: Float64Array };
        };
        const bounds = [...Array.from({ length: 199 }, (_, i) => i + 1), Infinity];
        const h = synth.synthHeatmap({
          seed: 20261120,
          fromMs: 0,
          toMs: 10_000_000,
          columns: 10_000,
          bounds,
        });
        if (nan) for (let k = 0; k < h.counts.length; k += 97) h.counts[k] = NaN;
        const canvas = new OffscreenCanvas(1200, 400);
        const ctx = canvas.getContext('2d');
        if (ctx === null) throw new Error('no 2D context');
        const input = {
          ctx,
          spec: { kind: 'heatmap', title: '', unit: { kind: 'none' }, countUnit: { kind: 'none' } },
          data: { kind: 'heatmap', heatmap: h },
          window: { fromMs: 0, toMs: 10_000_000 },
          cssW: 1200,
          cssH: 400,
          timeZone: 'UTC',
          colours: palette.themeColours('light'),
        };
        let kind = '';
        for (let i = 0; i < warmup; i++) kind = draw.drawLayer(input).summary.kind;
        const times: number[] = [];
        for (let i = 0; i < samples; i++) {
          const t0 = performance.now();
          kind = draw.drawLayer(input).summary.kind;
          times.push(performance.now() - t0);
        }
        return { times, kind };
      },
      { warmup: WARMUP, samples: SAMPLES, nan: withNaN },
    );
    expect(result.times).toHaveLength(SAMPLES);
    expect(result.kind).toBe('heatmap');
    const sorted = [...result.times].sort((a, b) => a - b);
    const report = {
      samples: result.times.length,
      nan: withNaN,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      unit: 'ms',
    };
    mkdirSync('test-results', { recursive: true });
    writeFileSync(
      'test-results/bench-interim-heatmap.json',
      `${JSON.stringify(report, null, 2)}\n`,
    );
    info.annotations.push({
      type: 'bench:frame-interim-heatmap',
      description: `p50 ${report.p50.toFixed(2)} ms, p95 ${report.p95.toFixed(2)} ms (${String(report.samples)} samples, NaN ${String(withNaN)})`,
    });
  });
});
