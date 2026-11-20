import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const RUNS = 20;

function percentile(sorted: number[], p: number): number {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i] ?? 0;
}

test.describe('bench:startup (report only, PRF-008)', () => {
  test('time to shell-ready over 20 cold loads', async ({ browser }, info) => {
    test.setTimeout(120_000);
    const times: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto('/t/demo/boards');
      await page.locator('html[data-shell-ready]').waitFor();
      const t = await page.evaluate(
        () => performance.getEntriesByName('shell-ready')[0]?.startTime ?? -1,
      );
      times.push(t);
      await context.close();
    }
    for (const t of times) expect(t).toBeGreaterThan(0);
    const sorted = [...times].sort((a, b) => a - b);
    const result = {
      runs: RUNS,
      p50: percentile(sorted, 50),
      p75: percentile(sorted, 75),
      unit: 'ms',
    };
    mkdirSync('test-results', { recursive: true });
    writeFileSync('test-results/prf-008.json', `${JSON.stringify(result, null, 2)}\n`);
    info.annotations.push({
      type: 'bench:startup',
      description: `p50 ${result.p50.toFixed(1)} ms, p75 ${result.p75.toFixed(1)} ms`,
    });
  });
});
