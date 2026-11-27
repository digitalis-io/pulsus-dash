/**
 * `bench:geomap-markers` (report-only; plan #234 Part 3 §5, T24 §7): the gallery's `geomap-bench`
 * page (Cap: 5 000 drawn markers) under 10 s of scripted pans and zooms in Chromium at 1×; reports
 * the p95 of the `chart-draw` measures of kind `geomap` against 16 ms. It never fails on the number.
 */
import { expect, test } from '@playwright/test';
import { open } from './helpers.ts';

test('bench:geomap-markers (report-only)', async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium', 'Chromium at 1× only');
  test.setTimeout(60_000);
  await open(page, '/t/demo/dev/geo?page=geomap-bench');
  const f = page.locator('[data-geo-gallery="geomap-bench"] [data-chart-frame]');
  await expect(f).toHaveAttribute('data-frame-ready', 'true');
  await page.evaluate(() => {
    const w = window as unknown as { __geoDraws: number[] };
    w.__geoDraws = [];
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        const d = (e as PerformanceMeasure).detail as { kind?: string } | null;
        if (e.name === 'chart-draw' && d?.kind === 'geomap') w.__geoDraws.push(e.duration);
      }
    }).observe({ entryTypes: ['measure'] });
  });
  const box = await f.boundingBox();
  if (box === null) throw new Error('no frame box');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const end = Date.now() + 10_000;
  let i = 0;
  while (Date.now() < end) {
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + (i % 2 === 0 ? 120 : -120), cy + 40, { steps: 12 });
    await page.mouse.up();
    await page.mouse.wheel(0, i % 2 === 0 ? -240 : 240);
    await page.waitForTimeout(80);
    i += 1;
  }
  const draws = await page.evaluate(
    () => (window as unknown as { __geoDraws: number[] }).__geoDraws,
  );
  const sorted = [...draws].sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))] ?? NaN;
  const line = `bench:geomap-markers draws=${String(draws.length)} p95=${p95.toFixed(2)} ms (budget 16 ms, report-only)`;
  info.annotations.push({ type: 'bench', description: line });
  console.log(line);
  expect(draws.length).toBeGreaterThan(0);
});
