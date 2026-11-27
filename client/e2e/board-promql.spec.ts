/**
 * Board PromQL panels against the PulsusDB fake through the http-mode BFF (plan #64 Part A §5.2,
 * A.3): auto-vis and the saved override, visible-only queries, cancellation, Open in Explore,
 * refresh under an absolute window (#101) and the panel states. Each browser uses its own days, so
 * the fake's records of parallel projects never match each other's; no test resets the fake.
 */
import { expect, test, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { HTTP_BFF, NEEDS_BFF, PREVIEW } from './bff.ts';
import { createBoard, deleteBoard } from './boardApi.ts';
import { fakeRequests, runShift, sec, type FakeRequest } from './fake.ts';
import { searchOf, timeTrigger } from './helpers.ts';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const W1 = Date.UTC(2026, 1, 1);
/**
 * The window the fake's data transcripts were recorded on (Explore's `W0`): a transcript with
 * samples answers only a window that holds them, so the rows that draw data use it.
 */
const W0 = Date.UTC(2026, 0, 1);
const HIST = 'sum by (le) (rate(http_request_duration_seconds_bucket[5m]))';

/** The project's index among the three browsers. */
function idx(info: TestInfo): number {
  return Math.max(0, ['chromium', 'firefox', 'webkit'].indexOf(info.project.name));
}

/** The start of this browser's day `k` (a 1 h window from it is the test's own). */
function day(info: TestInfo, k: number): number {
  return W1 + (idx(info) * 20 + k) * DAY;
}

const iso = (ms: number): string => new Date(ms).toISOString();

function boardUrl(uid: string, from: number, to: number = from + HOUR): string {
  const e = (ms: number) => encodeURIComponent(iso(ms));
  return `/t/demo/board/${uid}?from=${e(from)}&to=${e(to)}&refresh=off`;
}

const panel = (page: Page, title: string) =>
  page
    .locator('[data-panel]')
    .filter({ has: page.getByRole('heading', { level: 3, name: title, exact: true }) });

/** The ids of the panels that intersect the viewport vertically. */
function onScreen(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-panel]')]
      .filter((p) => {
        const r = p.getBoundingClientRect();
        return r.bottom > 0 && r.top < window.innerHeight;
      })
      .map((p) => p.dataset['panel'] ?? ''),
  );
}

function queries(request: APIRequestContext, from: number): Promise<FakeRequest[]> {
  return fakeRequests(request, { path: '/api/v1/query_range', start: sec(from) });
}

const settle = (page: Page) => page.waitForTimeout(1_000);

test.describe('e2e:board-promql (fake)', () => {
  test.skip(PREVIEW, NEEDS_BFF);
  test.use({ baseURL: HTTP_BFF, viewport: { width: 1440, height: 900 } });

  test('e2e:board-promql-panels', async ({ page, request }, info) => {
    test.setTimeout(120_000);
    const from = W0;
    const title = `E1 ${info.project.name} ${crypto.randomUUID()}`;
    // Wide enough that a new 6-column panel gets the 5 s step the histogram transcript is on.
    await page.setViewportSize({ width: 1920, height: 1080 });
    let uid: string | null = null;
    try {
      await page.goto('/t/demo/boards');
      await page.locator('html[data-shell-ready="true"]').waitFor();
      await page.getByRole('button', { name: 'New board' }).click();
      const create = page.getByRole('dialog', { name: 'New board' });
      await create.getByRole('textbox', { name: 'Name' }).fill(title);
      await create.getByRole('button', { name: 'Create' }).click();
      await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
      uid = new URL(page.url()).pathname.split('/').at(-1) ?? null;
      if (uid === null) throw new Error('no uid');
      await page.goto(boardUrl(uid, from));
      await page.getByRole('button', { name: 'Edit board' }).click();
      const editor = page.getByRole('dialog', { name: 'Edit panel' });
      const texts = ['http_requests_total', HIST, 'node_memory_free_bytes'];
      for (const [i, text] of texts.entries()) {
        await page.getByRole('button', { name: 'Add panel', exact: true }).click();
        await editor.getByRole('textbox', { name: 'Title' }).fill(`P${String(i + 1)}`);
        await editor.getByRole('textbox', { name: 'Query' }).click();
        await page.keyboard.insertText(text);
        await page.keyboard.press('Shift+Enter');
        await editor.getByRole('button', { name: 'Done' }).click();
        await expect(editor).toBeHidden();
      }
      // Check 1: what the fake answered, then the panels' auto-vis.
      for (const q of ['rate(http_requests_total[1m])', HIST, 'node_memory_free_bytes']) {
        await expect
          .poll(async () =>
            (await queries(request, from)).some((r) => r.query === q && r.state === 'completed'),
          )
          .toBe(true);
      }
      for (const t of ['P1', 'P2', 'P3']) {
        await expect(panel(page, t)).toHaveAttribute('data-panel-state', 'frame');
        await expect(panel(page, t)).toHaveAttribute('data-vis', 'auto');
      }
      await expect(panel(page, 'P1')).toHaveAttribute('data-panel-vis', 'line');
      await expect(panel(page, 'P2')).toHaveAttribute('data-panel-vis', 'heatmap');
      await expect(panel(page, 'P3')).toHaveAttribute('data-panel-vis', 'line');
      // #64 Part B: a line panel shows its legend by default.
      await expect(panel(page, 'P1').locator('[data-panel-legend]')).toBeVisible();

      // The override, saved with the panel.
      await page.getByRole('button', { name: 'Panel menu: P1' }).click();
      await page.getByRole('menuitem', { name: 'Edit panel' }).click();
      await editor.getByRole('button', { name: /Visualisation$/ }).click();
      await page.getByRole('option', { name: 'Stat', exact: true }).click();
      await editor.getByRole('button', { name: 'Done' }).click();
      await expect(editor).toBeHidden();
      const vis = { P1: 'stat', P2: 'heatmap', P3: 'line' };
      for (const [t, v] of Object.entries(vis)) {
        await expect(panel(page, t)).toHaveAttribute('data-panel-vis', v);
      }
      await page.keyboard.press('ControlOrMeta+S');
      await expect(page.getByRole('status', { name: 'Save status' })).toHaveText('Saved');
      await page.reload();
      await expect(page.getByRole('button', { name: 'Edit board' })).toBeVisible();
      await expect(page.locator('[data-panel] h3')).toHaveText(['P1', 'P2', 'P3']);
      const after = { P1: ['stat', 'stat'], P2: ['auto', 'heatmap'], P3: ['auto', 'line'] };
      for (const [t, [saved, drawn]] of Object.entries(after)) {
        await expect(panel(page, t)).toHaveAttribute('data-vis', saved ?? '');
        await expect(panel(page, t)).toHaveAttribute('data-panel-vis', drawn ?? '');
      }
      await page.getByRole('button', { name: 'Panel menu: P1' }).click();
      await page.getByRole('menuitem', { name: 'Edit panel' }).click();
      await expect(editor.getByRole('button', { name: /Visualisation$/ })).toContainText('Stat');
    } finally {
      await deleteBoard(request, uid);
    }
  });

  test('e2e:board-visible-only', async ({ page, request }, info) => {
    test.setTimeout(90_000);
    // Day 6: days 1–3 of February are Explore's `empty_metric` windows (e2e:explore-refresh).
    const from = day(info, 6) + runShift(info);
    const panels = Array.from({ length: 30 }, (_, k) => {
      const i = k + 1;
      return {
        id: `p-${String(i)}`,
        title: `Panel ${String(i)}`,
        // An empty answer fits any window, so each browser counts in its own (W0 is shared).
        text: 'empty_metric',
        grid: [4 * ((i - 1) % 3), 8 * Math.floor((i - 1) / 3), 4, 8] as [
          number,
          number,
          number,
          number,
        ],
      };
    });
    let uid: string | null = null;
    try {
      uid = await createBoard(request, `E2 ${info.project.name} ${crypto.randomUUID()}`, panels);
      await page.goto(boardUrl(uid, from));
      await expect(page.locator('[data-frame-ready="true"]')).toHaveCount(6);
      await settle(page);
      const v1 = await onScreen(page);
      expect(v1).toHaveLength(6);
      expect(await queries(request, from)).toHaveLength(6);
      await page.evaluate(() => {
        window.scrollBy(0, window.innerHeight);
      });
      await settle(page);
      const v2 = await onScreen(page);
      expect(v2.filter((id) => !v1.includes(id)).length).toBeGreaterThan(0);
      for (const id of v2) {
        await expect(page.locator(`[data-panel="${id}"] [data-frame-ready="true"]`)).toHaveCount(1);
      }
      await settle(page);
      const union = new Set([...v1, ...v2]);
      expect(await queries(request, from)).toHaveLength(union.size);
      await page.evaluate(() => {
        window.scrollTo(0, 0);
      });
      await settle(page);
      expect(await queries(request, from)).toHaveLength(union.size);
    } finally {
      await deleteBoard(request, uid);
    }
  });

  test('e2e:board-cancel', async ({ page, request }, info) => {
    // C has its own transcript (slow-final-<browser>.json, matched on its start): a series that A
    // and B never answer. The windows are fixed for it, so each run reads only the records it made
    // (after t0): a repeat or a retry is independent, two copies running at once are not (repeat
    // this test with --workers=1).
    const A = day(info, 2);
    const B = A + HOUR;
    const C = B + HOUR;
    const panels = [0, 4, 8].map((x, i) => ({
      id: `p-${String(i + 1)}`,
      title: `Slow ${String(i + 1)}`,
      text: 'slow_metric',
      grid: [x, 0, 4, 8] as [number, number, number, number],
    }));
    let uid: string | null = null;
    try {
      const t0 = Date.now();
      const slow = async (start: number) =>
        (await queries(request, start)).filter(
          (r) => r.query === 'slow_metric' && r.receivedAtMs >= t0,
        );
      uid = await createBoard(request, `E3 ${info.project.name} ${crypto.randomUUID()}`, panels);
      await page.goto(boardUrl(uid, A));
      await expect
        .poll(async () => (await slow(A)).filter((r) => r.state === 'inflight').length, {
          intervals: [50],
        })
        .toBe(3);
      // Both steps happen in the page, 100 ms apart (under the 200 ms of E3), so neither waits on
      // the runner or on reading the fake back. A's queries are held (2 s) and in flight.
      const steps = await page.evaluate(async (gapMs) => {
        const step = (): boolean => {
          const e = new KeyboardEvent('keydown', {
            key: ']',
            code: 'BracketRight',
            bubbles: true,
            cancelable: true,
          });
          document.body.dispatchEvent(e);
          return e.defaultPrevented;
        };
        const t0 = performance.now();
        const first = step();
        await new Promise((r) => setTimeout(r, gapMs));
        const second = step();
        return { handled: [first, second], ms: performance.now() - t0 };
      }, 100);
      expect(steps.handled).toEqual([true, true]);
      expect(steps.ms).toBeLessThan(200);
      // The outcomes, read back with time to spare: every superseded query (A's three, and any of
      // B's that left before the second step) was cancelled, and only C's three completed.
      const states = async (start: number) => (await slow(start)).map((r) => r.state);
      await expect
        .poll(
          async () => ({
            a: await states(A),
            bCancelled: (await states(B)).every((st) => st === 'cancelled'),
            c: await states(C),
            cFrom: [...new Set((await slow(C)).map((r) => r.transcript))],
          }),
          { timeout: 10_000 },
        )
        .toEqual({
          a: ['cancelled', 'cancelled', 'cancelled'],
          bCancelled: true,
          c: ['completed', 'completed', 'completed'],
          cFrom: [`slow-final-${info.project.name}`],
        });
      // Each panel drew C's answer: the engine's summary (the chart's label, set from the frame it
      // drew) has C's one series, 7 then 42, which A and B's transcript does not have.
      for (const p of panels) {
        const chart = panel(page, p.title).locator('[data-chart-frame]');
        await expect(chart).toHaveAttribute('data-frame-ready', 'true', { timeout: 10_000 });
        await expect(chart.locator('canvas')).toHaveAttribute(
          'aria-label',
          new RegExp(`^${p.title}: .*, 1 series, .*\\. Min 7, max 42, last 42\\.$`),
        );
      }
      expect(searchOf(page)['from']).toBe(iso(C));
      await expect(timeTrigger(page)).toBeVisible();
    } finally {
      await deleteBoard(request, uid);
    }
  });

  test('e2e:board-open-in-explore', async ({ page, request }, info) => {
    const from = W0;
    const from24 = day(info, 3);
    const mix =
      'avg_over_time(node_memory_free_bytes[$__interval]) + rate(http_requests_total[$__rate_interval])';
    let uid: string | null = null;
    try {
      uid = await createBoard(request, `E4 ${info.project.name} ${crypto.randomUUID()}`, [
        { id: 'p-1', title: 'Requests', text: 'http_requests_total', grid: [0, 0, 6, 8] },
        { id: 'p-2', title: 'Mix', text: mix, grid: [0, 8, 12, 8] },
      ]);
      // Case 1: 1 h; the link carries the raw text (expanded is before the rate rewrite).
      await page.goto(boardUrl(uid, from));
      await expect(panel(page, 'Requests')).toHaveAttribute('data-panel-state', 'frame');
      await page.getByRole('button', { name: 'Panel menu: Requests' }).click();
      await page.getByRole('menuitem', { name: 'Open in Explore' }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe('/t/demo/explore/metrics');
      expect(searchOf(page)['q']).toBe('http_requests_total');
      expect([searchOf(page)['from'], searchOf(page)['to']]).toEqual([iso(from), iso(from + HOUR)]);
      await expect(page.getByRole('textbox', { name: 'PromQL query' })).toHaveText(
        'http_requests_total',
      );

      // Case 2: 24 h on a 12-column body (961–1 440 px): step 1 m, so [1m] and [75s] (#303).
      await page.goto(boardUrl(uid, from24, from24 + DAY));
      await expect(page.getByRole('link', { name: 'Open in Explore: Mix' })).toBeVisible();
      const mixSent = async (): Promise<string> =>
        (await queries(request, from24)).find((x) =>
          x.query.startsWith('avg_over_time(node_memory_free_bytes['),
        )?.query ?? '';
      // The server substituted the macros at the panel's step.
      await expect.poll(mixSent).toMatch(/\[1m\].*\[75s\]/);
      const sent = await mixSent();
      await page.getByRole('button', { name: 'Panel menu: Mix' }).click();
      await page.getByRole('menuitem', { name: 'Open in Explore' }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe('/t/demo/explore/metrics');
      expect(searchOf(page)['q']).toBe(sent);
      await expect(page.getByRole('textbox', { name: 'PromQL query' })).toHaveText(sent);
    } finally {
      await deleteBoard(request, uid);
    }
  });

  test('e2e:board-refresh', async ({ page, request }, info) => {
    const R = day(info, 4) + runShift(info);
    let uid: string | null = null;
    const done = async () =>
      (
        await fakeRequests(request, {
          query: 'empty_metric',
          start: sec(R),
          state: 'completed',
        })
      ).length;
    try {
      uid = await createBoard(request, `E5 ${info.project.name} ${crypto.randomUUID()}`, [
        { id: 'p-1', title: 'Empty 1', text: 'empty_metric', grid: [0, 0, 6, 8] },
        { id: 'p-2', title: 'Empty 2', text: 'empty_metric', grid: [6, 0, 6, 8] },
      ]);
      await page.goto(boardUrl(uid, R));
      await expect.poll(done).toBe(2);
      await page.getByRole('button', { name: 'Refresh now' }).click();
      await expect.poll(done).toBe(4);
    } finally {
      await deleteBoard(request, uid);
    }
  });

  test('e2e:board-states', async ({ page, request }, info) => {
    const from = day(info, 5) + runShift(info);
    let uid: string | null = null;
    try {
      uid = await createBoard(request, `E6 ${info.project.name} ${crypto.randomUUID()}`, [
        { id: 'p-1', title: 'Top', text: 'topk(1000, up)', grid: [0, 0, 6, 8] },
        { id: 'p-2', title: 'Broad', text: '{__name__=~".+"}', grid: [6, 0, 6, 8] },
        {
          id: 'p-3',
          title: 'Parse',
          text: 'rate(http_server_duration_bucket{service="checkout"[5m])',
          grid: [0, 8, 6, 8],
        },
        { id: 'p-4', title: 'Empty', text: '', grid: [6, 8, 6, 8] },
      ]);
      await page.goto(boardUrl(uid, from));
      await page.getByRole('button', { name: 'Partial data: Top' }).click();
      await expect(page.getByRole('status', { name: 'Query notices' })).toContainText(
        'results truncated due to limit',
      );
      await page.keyboard.press('Escape');
      await expect(panel(page, 'Broad').getByRole('alert')).toBeVisible();
      await expect(
        panel(page, 'Broad').getByRole('button', { name: 'Narrow the time range' }),
      ).toBeVisible();
      await expect(panel(page, 'Parse').getByRole('alert')).toHaveText(/\(line 1, column \d+\)$/);
      await expect(panel(page, 'Empty').getByText('Add a query')).toBeVisible();
      // Three requests: the empty panel sends none.
      await expect.poll(async () => (await queries(request, from)).length).toBe(3);
      await page.waitForTimeout(500);
      expect(await queries(request, from)).toHaveLength(3);
    } finally {
      await deleteBoard(request, uid);
    }
  });
});
