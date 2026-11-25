/**
 * `bench:inspector-redraw` (report only; T25 §7, plan #192 §5): the layer redraw time of the stub
 * board's "Request rate" chart over 40 theme changes, first with no selection and the Inspector
 * closed, then with its first series selected and the Inspector open (its backdrop blur over the
 * board). The p95 ratio is reported; above 1.10 it is a MINOR finding, never a failure.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { waitReady } from './helpers.ts';

const RUNS = 40;
const BOARD = '/t/demo/board/b-1';

declare global {
  interface Window {
    __inspectorDraws: number[];
    __inspectorObserver?: PerformanceObserver;
  }
}

function percentile(sorted: number[], p: number): number {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i] ?? 0;
}

/** The `chart-draw` durations of frame `id` over RUNS theme changes. */
async function draws(page: Page, id: string): Promise<number[]> {
  await page.evaluate((f) => {
    window.__inspectorDraws = [];
    window.__inspectorObserver?.disconnect();
    window.__inspectorObserver = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const detail = (e as PerformanceMeasure).detail as { frame?: string | null } | null;
        if (e.name === 'chart-draw' && detail?.frame === f)
          window.__inspectorDraws.push(e.duration);
      }
    });
    window.__inspectorObserver.observe({ type: 'measure' });
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
    .poll(() => page.evaluate(() => window.__inspectorDraws.length))
    .toBeGreaterThanOrEqual(RUNS);
  return page.evaluate(() => window.__inspectorDraws);
}

test('bench:inspector-redraw (report only)', async ({ page }, info) => {
  test.setTimeout(60_000);
  // No fake clock: it replaces the page's User Timing methods (as perf-chart-redraw).
  await page.goto(BOARD);
  await waitReady(page, BOARD);
  const frame = page.locator('[data-panel-id="p-1"] [data-chart-frame][data-frame-ready="true"]');
  await frame.waitFor();
  const id = (await frame.getAttribute('data-frame-id')) ?? '';
  expect(id).not.toBe('');
  const base = [...(await draws(page, id))].sort((a, b) => a - b);

  // The first series selected through the legend, then the Inspector opened on the chart.
  await page
    .getByRole('button', { name: /^Select / })
    .first()
    .click();
  const box = await frame.boundingBox();
  const [px = 0, py = 0, pw = 0, ph = 0] =
    (await frame.getAttribute('data-plot'))?.split(',').map(Number) ?? [];
  if (box === null) throw new Error('no chart box');
  for (let f = 0.1; f < 0.95; f += 0.05) {
    await page.mouse.click(box.x + px + pw * 0.7, box.y + py + ph * f);
    if ((await page.locator('[data-inspector]').count()) > 0) break;
  }
  await expect(page.locator('[data-inspector]')).toHaveCount(1);
  const selected = [...(await draws(page, id))].sort((a, b) => a - b);

  const result = {
    samples: [base.length, selected.length],
    p95: { none: percentile(base, 95), inspector: percentile(selected, 95) },
    ratio: percentile(selected, 95) / Math.max(percentile(base, 95), 1e-6),
    unit: 'ms',
  };
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/bench-inspector-redraw.json', `${JSON.stringify(result, null, 2)}\n`);
  info.annotations.push({
    type: 'bench:inspector-redraw',
    description: `p95 ${result.p95.none.toFixed(2)} → ${result.p95.inspector.toFixed(2)} ms, ratio ${result.ratio.toFixed(2)}${result.ratio > 1.1 ? ' (MINOR: above 1.10)' : ''}`,
  });
});
