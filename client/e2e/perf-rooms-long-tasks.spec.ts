/**
 * `bench:rooms-long-tasks` (#90, plan §3.7 and Appendix B §B.5; PRF-005, T05 §4.3, T08 §7): the
 * main-thread long tasks of scripted room interactions, from a Chromium trace. The board editor is
 * its first scenario, chart gestures on a board panel its second (#93). CI's `e2e` Chromium leg always asserts T05 §4.3's interim trace check (no
 * task over 50 ms wall with over 16 ms thread time); `LONG_TASK_GATE=enforce` (the reference lab,
 * #68, and the D13 local proofs) also fails any task over 16 ms wall. No fake clock.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import {
  CHART_INPUTS,
  longTasks,
  type LongTaskResult,
  type TraceEvent,
} from '../scripts/longTasks.ts';
import { boardEditorScenario, type Step } from './boardEditorScenario.ts';
import { chartGestureScenario } from './chartGestureScenario.ts';

const CATEGORIES = [
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'blink.user_timing',
];

const describe = (tasks: LongTaskResult['tasks']): string =>
  tasks
    .map(
      (x) =>
        `${x.label}: ${x.durMs.toFixed(1)} ms wall, ${x.threadMs === null ? 'no' : x.threadMs.toFixed(1)} ms thread`,
    )
    .join('; ');

/** Opens b-1, traces `scenario` with a `step:<label>` mark per step, and parses the trace. */
async function traced(
  page: Page,
  browser: Browser,
  scenario: (page: Page, step: Step) => Promise<void>,
  inputs?: readonly string[],
): Promise<{ r: LongTaskResult; pageErrors: string[] }> {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto('/t/demo/board/b-1');
  await page.locator('html[data-shell-ready="true"]').waitFor();
  await expect(page.locator('[data-chart-frame][data-frame-ready="true"]')).toHaveCount(3);
  await browser.startTracing(page, { categories: CATEGORIES });
  await scenario(page, async (label, _count, act) => {
    await page.evaluate((l) => {
      performance.mark(`step:${l}`);
    }, label);
    await act();
  });
  const trace = JSON.parse(String(await browser.stopTracing())) as { traceEvents: TraceEvent[] };
  const r = longTasks(trace.traceEvents, inputs === undefined ? {} : { inputs });
  return { r, pageErrors };
}

/** The JSON, the annotation, and the CI and (with `LONG_TASK_GATE=enforce`) 16 ms checks. */
function gate(r: LongTaskResult, info: TestInfo, file: string, scenario: string): void {
  const enforce = process.env['LONG_TASK_GATE'] === 'enforce';
  const result = { ...r, scenario, mode: enforce ? 'enforce' : 'ci', unit: 'ms' };
  mkdirSync('test-results', { recursive: true });
  writeFileSync(`test-results/${file}`, `${JSON.stringify(result, null, 2)}\n`);
  info.annotations.push({
    type: 'bench:rooms-long-tasks',
    description: `${scenario}: ${String(r.over16)} tasks over 16 ms (worst ${r.worstMs.toFixed(1)} ms), ${String(r.ciOver)} over the CI check, ${String(r.clicks)} clicks, ${String(r.keydowns)} keydowns`,
  });
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
}

test('bench:rooms-long-tasks board editor (CI thresholds; 16 ms wall with LONG_TASK_GATE=enforce)', async ({
  page,
  browser,
}, info) => {
  test.setTimeout(120_000);
  const { r, pageErrors } = await traced(page, browser, boardEditorScenario);
  expect(r.clicks).toBeGreaterThanOrEqual(28);
  expect(r.keydowns).toBeGreaterThanOrEqual(15);
  expect(pageErrors).toEqual([]);
  gate(r, info, 'bench-rooms-long-tasks.json', 'board editor');
});

test('bench:rooms-long-tasks chart gestures (CI thresholds; 16 ms wall with LONG_TASK_GATE=enforce)', async ({
  page,
  browser,
}, info) => {
  test.setTimeout(120_000);
  const { r, pageErrors } = await traced(page, browser, chartGestureScenario, CHART_INPUTS);
  expect(r.counts['wheel'] ?? 0).toBeGreaterThanOrEqual(40);
  expect(r.counts['pointerdown'] ?? 0).toBeGreaterThanOrEqual(8);
  expect(r.counts['contextmenu'] ?? 0).toBeGreaterThanOrEqual(3);
  expect(pageErrors).toEqual([]);
  gate(r, info, 'bench-rooms-long-tasks-chart.json', 'chart gestures');
});
