/**
 * `bench:frame-interim-line` (report only until #68; plan #58 §5): the layer redraw time of the
 * 50 × 1 440 line chart over 40 theme changes. No threshold; p50 and p95 are reported. A separate
 * test with a 30 s limit records the `line-extreme` frame, values over [−MAX, MAX] (#97).
 * `bench:frame-interim-categories` (report only; plan #173 Part 2) times the 200-bar
 * `barchart-cap` frame of `&bench=categories` over 50 theme changes.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { frame, GALLERY_URL, galleryReady, waitReady } from './helpers.ts';

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
  // No fake clock: it replaces the page's User Timing methods. The gallery window is absolute.
  await page.goto(GALLERY_URL);
  await waitReady(page, GALLERY_URL);
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

test('bench:frame-interim-line line-extreme (report only)', async ({ page }, info) => {
  test.setTimeout(30_000);
  await page.goto(GALLERY_URL);
  await waitReady(page, GALLERY_URL);
  await galleryReady(page);
  const id = await frame(page, 'line-extreme').getAttribute('data-frame-id');
  expect(id, 'line-extreme has no data-frame-id').not.toBeNull();
  await page.evaluate((f) => {
    window.__chartDraws = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const detail = (e as PerformanceMeasure).detail as { frame?: string | null } | null;
        if (e.name === 'chart-draw' && detail?.frame === f) window.__chartDraws.push(e.duration);
      }
    }).observe({ type: 'measure' });
  }, id);
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
  writeFileSync(
    'test-results/bench-interim-line-extreme.json',
    `${JSON.stringify(result, null, 2)}\n`,
  );
  info.annotations.push({
    type: 'bench:frame-interim-line line-extreme',
    description: `p50 ${result.p50.toFixed(2)} ms, p95 ${result.p95.toFixed(2)} ms (${String(result.samples)} samples)`,
  });
});

test('bench:frame-interim-categories (report only)', async ({ page }, info) => {
  // Only `barchart-cap`, 600 px wide with a 2 800 px category extent: 200 bars (plan #173 Part 2).
  const url = `${GALLERY_URL}&bench=categories`;
  const RUNS_CATEGORIES = 50;
  await page.goto(url);
  await waitReady(page, url);
  await expect(page.locator('[data-chart-frame][data-frame-ready="true"]')).toHaveCount(1);
  await page.evaluate(() => {
    window.__chartDraws = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const detail = (e as PerformanceMeasure).detail as { series?: number } | null;
        if (e.name === 'chart-draw' && detail?.series === 200) window.__chartDraws.push(e.duration);
      }
    }).observe({ type: 'measure' });
  });
  for (let i = 0; i < RUNS_CATEGORIES; i++) {
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
    .toBeGreaterThanOrEqual(RUNS_CATEGORIES);
  const times = await page.evaluate(() => window.__chartDraws);
  const sorted = [...times].sort((a, b) => a - b);
  const result = {
    samples: times.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    unit: 'ms',
  };
  mkdirSync('test-results', { recursive: true });
  writeFileSync(
    'test-results/bench-interim-categories.json',
    `${JSON.stringify(result, null, 2)}\n`,
  );
  info.annotations.push({
    type: 'bench:frame-interim-categories',
    description: `p50 ${result.p50.toFixed(2)} ms, p95 ${result.p95.toFixed(2)} ms (${String(result.samples)} samples)`,
  });
});
