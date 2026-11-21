/**
 * `bench:editor-keystroke` (PRF-005, T09-003; plan #63 Part C Appendix C.6, D-BENCH; Chromium
 * only, stub BFF): 100 keys typed at the end of a 1 KB PromQL query. Each sample is the main-thread
 * task time (CDP `Performance.getMetrics` `TaskDuration`) from the key press through two animation
 * frames, minus the median of 30 samples without a key. Report only on shared CI; with
 * `EDITOR_BENCH_GATE=enforce` (the reference lab, and the local D13 proof) p95 ≤ 2 ms and no key
 * over 16 ms, else the test fails.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { open } from './helpers.ts';

const enforce = process.env['EDITOR_BENCH_GATE'] === 'enforce';
const P95_MS = 2.0;
const MAX_MS = 16;
const WARMUP = 20;
const MEASURED = 100;
const IDLE = 30;
const KEYS = ' or up'.split('');

/** 19 terms of 51 characters joined by ` + `, then a newline: 1 024 bytes. */
const Q1K = `${Array.from(
  { length: 19 },
  (_, i) => `rate(http_requests_total{job="api",shard="${String(i).padStart(2, '0')}"}[5m])`,
).join(' + ')}\n`;

function percentile(sorted: readonly number[], p: number): number {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i] ?? 0;
}

async function taskMs(cdp: CDPSession): Promise<number> {
  const { metrics } = await cdp.send('Performance.getMetrics');
  return (metrics.find((m) => m.name === 'TaskDuration')?.value ?? 0) * 1000;
}

async function frames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((r) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            r();
          });
        });
      }),
  );
}

test('bench:editor-keystroke', async ({ page }, info) => {
  test.setTimeout(120_000);
  expect(new TextEncoder().encode(Q1K).length).toBe(1024);
  await open(
    page,
    `/t/demo/explore/metrics?from=now-1h&to=now&refresh=off&q=${encodeURIComponent(Q1K)}`,
  );
  const editor = page.getByRole('textbox', { name: 'PromQL query' });
  await expect(editor).toBeVisible();
  await expect(page.locator('[data-chart-frame][data-frame-ready="true"]')).toBeVisible();
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');

  const sample = async (press?: () => Promise<void>): Promise<number> => {
    const before = await taskMs(cdp);
    await press?.();
    await frames(page);
    return (await taskMs(cdp)) - before;
  };
  const idle: number[] = [];
  for (let i = 0; i < IDLE; i++) idle.push(await sample());
  const overheadMs = percentile(
    [...idle].sort((a, b) => a - b),
    50,
  );

  const keyAt = (i: number) => KEYS[i % KEYS.length] ?? ' ';
  const press = (k: string) => () => page.keyboard.press(k === ' ' ? 'Space' : k);
  for (let i = 0; i < WARMUP; i++) await sample(press(keyAt(i)));
  const samples: number[] = [];
  for (let i = WARMUP; i < WARMUP + MEASURED; i++) {
    samples.push((await sample(press(keyAt(i)))) - overheadMs);
  }

  expect(samples).toHaveLength(MEASURED);
  const text = await editor.evaluate((e) => e.textContent);
  expect(text.length + 1).toBe(Q1K.length + WARMUP + MEASURED);
  const sorted = [...samples].sort((a, b) => a - b);
  const report = {
    samples: samples.length,
    overheadMs,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted.at(-1) ?? 0,
  };
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/bench-editor-keystroke.json', `${JSON.stringify(report, null, 2)}\n`);
  info.annotations.push({
    type: 'bench:editor-keystroke',
    description: `p50 ${report.p50.toFixed(2)} ms, p95 ${report.p95.toFixed(2)} ms, max ${report.max.toFixed(2)} ms, overhead ${overheadMs.toFixed(2)} ms`,
  });
  const breaches = [
    ...(report.p95 > P95_MS ? [`p95 ${report.p95.toFixed(2)} ms > ${String(P95_MS)} ms`] : []),
    ...(report.max > MAX_MS ? [`max ${report.max.toFixed(2)} ms > ${String(MAX_MS)} ms`] : []),
  ];
  if (enforce) expect(breaches).toEqual([]);
  else for (const b of breaches) info.annotations.push({ type: 'warning', description: b });
});
