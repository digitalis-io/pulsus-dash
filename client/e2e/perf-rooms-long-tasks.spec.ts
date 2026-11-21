/**
 * `bench:rooms-long-tasks` (#90, plan §3.7 and Appendix B §B.5; PRF-005, T05 §4.3, T08 §7): the
 * main-thread long tasks of scripted room interactions, from a Chromium trace. The board editor is
 * its first scenario. CI's `e2e` Chromium leg always asserts T05 §4.3's interim trace check (no
 * task over 50 ms wall with over 16 ms thread time); `LONG_TASK_GATE=enforce` (the reference lab,
 * #68, and the D13 local proofs) also fails any task over 16 ms wall. No fake clock.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { longTasks, type TraceEvent } from '../scripts/longTasks.ts';
import { boardEditorScenario } from './boardEditorScenario.ts';

const CATEGORIES = [
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'blink.user_timing',
];

test('bench:rooms-long-tasks board editor (CI thresholds; 16 ms wall with LONG_TASK_GATE=enforce)', async ({
  page,
  browser,
}, info) => {
  test.setTimeout(120_000);
  const enforce = process.env['LONG_TASK_GATE'] === 'enforce';
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto('/t/demo/board/b-1');
  await page.locator('html[data-shell-ready="true"]').waitFor();
  await expect(page.locator('[data-chart-frame][data-frame-ready="true"]')).toHaveCount(3);

  await browser.startTracing(page, { categories: CATEGORIES });
  await boardEditorScenario(page, async (label, _count, act) => {
    await page.evaluate((l) => {
      performance.mark(`step:${l}`);
    }, label);
    await act();
  });
  const trace = JSON.parse(String(await browser.stopTracing())) as { traceEvents: TraceEvent[] };
  const r = longTasks(trace.traceEvents);

  const result = { ...r, mode: enforce ? 'enforce' : 'ci', unit: 'ms' };
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/bench-rooms-long-tasks.json', `${JSON.stringify(result, null, 2)}\n`);
  info.annotations.push({
    type: 'bench:rooms-long-tasks',
    description: `${String(r.over16)} tasks over 16 ms (worst ${r.worstMs.toFixed(1)} ms), ${String(r.ciOver)} over the CI check, ${String(r.clicks)} clicks, ${String(r.keydowns)} keydowns`,
  });

  expect(r.clicks).toBeGreaterThanOrEqual(28);
  expect(r.keydowns).toBeGreaterThanOrEqual(15);
  expect(pageErrors).toEqual([]);
  const describe = (tasks: typeof r.tasks): string =>
    tasks
      .map(
        (x) =>
          `${x.label}: ${x.durMs.toFixed(1)} ms wall, ${x.threadMs === null ? 'no' : x.threadMs.toFixed(1)} ms thread`,
      )
      .join('; ');
  const ci = r.tasks.filter((x) => x.durMs > 50 && (x.threadMs === null || x.threadMs > 16));
  expect(r.ciOver, describe(ci)).toBe(0);
  if (enforce) {
    expect(r.over16, describe(r.tasks)).toBe(0);
  } else {
    for (const x of r.tasks) {
      info.annotations.push({
        type: 'warning',
        description: `long task ${describe([x])} (over 16 ms wall: fails only with LONG_TASK_GATE=enforce, T05-006)`,
      });
    }
  }
});
