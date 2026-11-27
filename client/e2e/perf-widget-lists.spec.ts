/**
 * `bench:widget-lists` (plan #216 Part 2a §5; T24 §7): the Board list's commits at up to 1 000 plain
 * DOM rows, on Chromium against the production stub build. Report-only; `LONG_TASK_GATE=enforce`
 * fails a p95 over 16 ms.
 *
 * The stub is seeded (`pulsus-dash.stub.boards`) with 1 002 boards titled `bulk-…` and a board with
 * one search list on `bulk`, limit 50. Steps: open, Show more ×19 (1 000 rows), then 20
 * `visibilitychange` refetches (`refetchOnWindowFocus: 'always'`), each awaited through the
 * list's `data-board-list-updated` (the answer's time). With `pulsus-dash.bench.boardList` set,
 * `BoardListCore` marks each render and measures `boardList:render` per commit (non-http builds); the p50, p95 and
 * max go to stdout and `test-results/widget-lists.json`. No samples fails the run.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { BOARD_TIME } from './helpers.ts';

const enforce = process.env['LONG_TASK_GATE'] === 'enforce';
const BUDGET_MS = 16;
const UID = 'b-lists-bench';
const BULK = Array.from({ length: 1002 }, (_, i) => {
  const uid = `bulk-${String(i + 1).padStart(4, '0')}`;
  return {
    uid,
    title: uid,
    updatedAt: new Date(Date.UTC(2026, 10, 19, 11) - i * 1000).toISOString(),
    spec: { title: uid, panels: [], sections: [] },
  };
});
const BOARD = {
  uid: UID,
  title: 'Lists bench',
  updatedAt: '2026-11-19T12:00:00.000Z',
  spec: {
    title: 'Lists bench',
    panels: [
      {
        id: 'p-1',
        title: 'Bulk',
        grid: { x: 0, y: 0, w: 12, h: 20 },
        vis: { kind: 'boardList', options: { mode: 'search', query: 'bulk', limit: 50 } },
      },
    ],
    sections: [],
  },
};

const pct = (sorted: readonly number[], p: number): number =>
  sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? 0;

test('bench:widget-lists (report-only; LONG_TASK_GATE=enforce fails a miss)', async ({ page }) => {
  test.setTimeout(240_000);
  await page.addInitScript(
    (boards) => {
      localStorage.setItem('pulsus-dash.stub.boards', JSON.stringify(boards));
      localStorage.setItem('pulsus-dash.bench.boardList', '1');
    },
    [...BULK, BOARD],
  );
  await page.goto(`/t/demo/board/${UID}?${BOARD_TIME}`);
  const rows = page.locator('[data-board-list-rows] li');
  await expect(rows).toHaveCount(50, { timeout: 30_000 });
  const more = page.getByRole('button', { name: 'Show more' });
  for (let i = 1; i <= 19; i++) {
    await more.click();
    await expect(rows).toHaveCount(50 + i * 50);
  }
  const list = page.locator('[data-board-list]');
  for (let i = 0; i < 20; i++) {
    const before = await list.getAttribute('data-board-list-updated');
    await page.evaluate(() => {
      window.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(list).not.toHaveAttribute('data-board-list-updated', before ?? '');
    await expect(list).not.toHaveAttribute('data-board-list-fetching', '');
  }
  await expect(rows).toHaveCount(1000);
  const samples = await page.evaluate(() =>
    performance.getEntriesByName('boardList:render', 'measure').map((m) => m.duration),
  );
  expect(samples.length, 'no boardList:render samples').toBeGreaterThan(0);
  const s = [...samples].sort((a, b) => a - b);
  const report = { n: s.length, p50: pct(s, 0.5), p95: pct(s, 0.95), max: s.at(-1) ?? 0 };
  console.log(`bench:widget-lists ${JSON.stringify(report)}`);
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/widget-lists.json', `${JSON.stringify(report, null, 2)}\n`);
  if (enforce) expect(report.p95, 'boardList:render p95 (ms)').toBeLessThanOrEqual(BUDGET_MS);
});
