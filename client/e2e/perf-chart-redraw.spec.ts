/**
 * `bench:frame-interim-line` (report only until #68; plan #58 §5): the layer redraw time of the
 * 50 × 1 440 line chart over 40 theme changes. No threshold; p50 and p95 are reported.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { GALLERY_URL, galleryReady, open } from './helpers.ts';

const RUNS = 40;

declare global {
  interface Window {
    __chartDraws: number[];
  }
}

function percentile(sorted: number[], p: number): number {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i] ?? 0;
}

test('bench:frame-interim-line (report only)', async ({ page }, info) => {
  await open(page, GALLERY_URL);
  await galleryReady(page);
  await page.evaluate(() => {
    window.__chartDraws = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const detail = (e as PerformanceMeasure).detail as { series?: number } | null;
        if (e.name === 'chart-draw' && detail?.series === 50) window.__chartDraws.push(e.duration);
      }
    }).observe({ type: 'measure' });
  });
  for (let i = 0; i < RUNS; i++) {
    await page.evaluate(
      (theme) =>
        new Promise<void>((r) => {
          document.documentElement.dataset['theme'] = theme;
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              r();
            });
          });
        }),
      i % 2 === 0 ? 'light' : 'dark',
    );
  }
  await expect
    .poll(() => page.evaluate(() => window.__chartDraws.length))
    .toBeGreaterThanOrEqual(RUNS);
  const times = await page.evaluate(() => window.__chartDraws);
  const sorted = [...times].sort((a, b) => a - b);
  const result = {
    samples: times.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    unit: 'ms',
  };
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/bench-interim-line.json', `${JSON.stringify(result, null, 2)}\n`);
  info.annotations.push({
    type: 'bench:frame-interim-line',
    description: `p50 ${result.p50.toFixed(2)} ms, p95 ${result.p95.toFixed(2)} ms (${String(result.samples)} samples)`,
  });
});
