/**
 * Board LogQL panels against the PulsusDB fake through the http-mode BFF (plan #67 §5.3): a board
 * with a PromQL panel, a stream panel and a Bars panel saved and reloaded; the volume brush
 * narrowing every panel's window; and a stream panel paging to its end. Each test reads the
 * panels' requests in the browser. The window is the log transcripts' (`L0`…`L0 + 1 h`).
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { HTTP_BFF, NEEDS_BFF, PREVIEW } from './bff.ts';
import { createBoard, deleteBoard } from './boardApi.ts';
import { brushTargets, searchOf } from './helpers.ts';

/** 2026-01-01T12:00Z: the window of the log transcripts. */
const L0 = Date.UTC(2026, 0, 1, 12);
const HOUR = 3_600_000;
const MIN = 60_000;
const PROM = '/api/dash/v1/query/promql/range';
const RANGE = '/api/dash/v1/query/logql/range';
const VOLUME = '/api/dash/v1/query/logql/volume';

/**
 * The PromQL panel's query: the `empty` transcript's empty matrix is valid on any grid. The gauge
 * transcript's samples lie on its own window's grid (00:00–01:00), off this one, which the BFF
 * refuses as a protocol error.
 */
const PROMQL = 'empty_metric';

const iso = (ms: number): string => new Date(ms).toISOString();

function boardUrl(uid: string, from = L0, to = L0 + HOUR): string {
  const e = (ms: number) => encodeURIComponent(iso(ms));
  return `/t/demo/board/${uid}?from=${e(from)}&to=${e(to)}&refresh=off`;
}

interface Body {
  query: string;
  from: number;
  to: number;
  width_px: number;
  limit?: number;
  cursor?: string;
  direction?: string;
}

/** The page's PromQL range, LogQL range and volume request bodies, in order. */
function bodies(page: Page): { prom: Body[]; range: Body[]; volume: Body[] } {
  const out = { prom: [] as Body[], range: [] as Body[], volume: [] as Body[] };
  page.on('request', (r) => {
    if (r.method() !== 'POST') return;
    const path = new URL(r.url()).pathname;
    if (path === PROM) out.prom.push(r.postDataJSON() as Body);
    if (path === RANGE) out.range.push(r.postDataJSON() as Body);
    if (path === VOLUME) out.volume.push(r.postDataJSON() as Body);
  });
  return out;
}

function clear(b: ReturnType<typeof bodies>): void {
  b.prom.length = 0;
  b.range.length = 0;
  b.volume.length = 0;
}

/** A layout change moves the step off the volume transcript's 5 s: fail with this, not a 404. */
function widthChecked(v: Body | undefined): void {
  expect(v, 'a volume request').toBeDefined();
  const w = v?.width_px ?? 0;
  expect(w, 'width_px gives step 5 s on 1 h (720 ≤ w < 3600)').toBeGreaterThanOrEqual(720);
  expect(w, 'width_px gives step 5 s on 1 h (720 ≤ w < 3600)').toBeLessThan(3600);
}

const panel = (page: Page, title: string): Locator =>
  page
    .locator('[data-panel]')
    .filter({ has: page.getByRole('heading', { level: 3, name: title, exact: true }) });
const rows = (page: Page, title: string): Locator =>
  page.getByRole('list', { name: `Log lines: ${title}` }).locator('[data-log-row]');
const frameOf = (page: Page, title: string): Locator =>
  panel(page, title).locator('[data-chart-frame]');
const readyFrame = (page: Page, title: string): Locator =>
  panel(page, title).locator('[data-chart-frame][data-frame-ready="true"]');
const summary = (page: Page, title: string) =>
  frameOf(page, title).locator('canvas').getAttribute('aria-label');

test.describe('e2e:board-logql (fake)', () => {
  test.skip(PREVIEW, NEEDS_BFF);
  test.use({ baseURL: HTTP_BFF, viewport: { width: 1920, height: 1080 } });

  test('e2e:board-logql-save', async ({ page, request }, info) => {
    test.setTimeout(120_000);
    const title = `LQ1 ${info.project.name} ${crypto.randomUUID()}`;
    const b = bodies(page);
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
      await page.goto(boardUrl(uid));
      await page.getByRole('button', { name: 'Edit board' }).click();
      const editor = page.getByRole('dialog', { name: 'Edit panel' });
      const specs = [
        ['P1', 'PromQL', PROMQL, null],
        ['P2', 'LogQL', '{app="checkout"}', null],
        ['P3', 'LogQL', '{app="checkout"}', 'Bars'],
      ] as const;
      for (const [name, lang, text, vis] of specs) {
        await page.getByRole('button', { name: 'Add panel', exact: true }).click();
        await editor.getByRole('textbox', { name: 'Title' }).fill(name);
        if (lang === 'LogQL') {
          await editor.getByRole('button', { name: /Query language$/ }).click();
          await page.getByRole('option', { name: 'LogQL', exact: true }).click();
          await expect(
            editor.getByRole('button', { name: /^LogQL Query language$/ }),
          ).toBeVisible();
        }
        await editor.getByRole('textbox', { name: 'Query' }).click();
        await page.keyboard.insertText(text);
        // Run query, not the Run keys: a completion list opening on the typed text cannot take it.
        await editor.getByRole('button', { name: 'Run query' }).click();
        if (vis !== null) {
          await editor.getByRole('button', { name: /Visualisation$/ }).click();
          await page.getByRole('option', { name: vis, exact: true }).click();
        }
        await editor.getByRole('button', { name: 'Done' }).click();
        await expect(editor).toBeHidden();
      }

      const check = async (): Promise<void> => {
        const saved = { P1: 'auto', P2: 'auto', P3: 'bars' };
        for (const [t, v] of Object.entries(saved)) {
          await panel(page, t).scrollIntoViewIfNeeded();
          await expect(panel(page, t)).toHaveAttribute('data-vis', v);
        }
        await expect(panel(page, 'P1')).toHaveAttribute('data-panel-vis', 'line');
        await panel(page, 'P2').scrollIntoViewIfNeeded();
        await expect(panel(page, 'P2')).toHaveAttribute('data-panel-state', 'stream');
        await expect(rows(page, 'P2')).toHaveCount(6);
        await panel(page, 'P3').scrollIntoViewIfNeeded();
        await expect(readyFrame(page, 'P3')).toBeVisible();
        await expect.poll(() => summary(page, 'P3')).toMatch(/^P3: stacked bar chart, 2 series/);
      };
      await check();
      await page.keyboard.press('ControlOrMeta+S');
      await expect(page.getByRole('status', { name: 'Save status' })).toHaveText('Saved');
      clear(b);
      await page.reload();
      await expect(page.getByRole('button', { name: 'Edit board' })).toBeVisible();
      await expect(page.locator('[data-panel] h3')).toHaveText(['P1', 'P2', 'P3']);
      await check();
      widthChecked(b.volume[0]);
    } finally {
      await deleteBoard(request, uid);
    }
  });

  test('e2e:board-logql-brush', async ({ page, request }, info) => {
    test.setTimeout(120_000);
    const b = bodies(page);
    const uid = await createBoard(request, `LQ2 ${info.project.name} ${crypto.randomUUID()}`, [
      { id: 'p-1', title: 'P1', text: PROMQL, grid: [0, 0, 6, 8] },
      { id: 'p-2', title: 'P2', text: '{app="checkout"}', grid: [6, 0, 6, 8], lang: 'logql' },
      {
        id: 'p-3',
        title: 'P3',
        text: '{app="checkout"}',
        grid: [0, 8, 6, 8],
        lang: 'logql',
        vis: { kind: 'bars' },
      },
    ]);
    try {
      await page.goto(boardUrl(uid));
      await page.locator('html[data-shell-ready="true"]').waitFor();
      await expect(panel(page, 'P1')).toHaveAttribute('data-panel-vis', 'line');
      await expect(rows(page, 'P2')).toHaveCount(6);
      await panel(page, 'P3').scrollIntoViewIfNeeded();
      await expect(readyFrame(page, 'P3')).toBeVisible();
      widthChecked(b.volume[0]);
      await page.waitForTimeout(1_000);
      clear(b);
      const { x1, x2, y } = await brushTargets(page, frameOf(page, 'P3'), L0, L0 + HOUR);
      await page.mouse.move(x1, y);
      await page.mouse.down({ button: 'right' });
      await page.mouse.move(x2, y, { steps: 10 });
      await page.mouse.up({ button: 'right' });
      await expect
        .poll(() => searchOf(page))
        .toMatchObject({ from: '2026-01-01T12:20:00.000Z', to: '2026-01-01T12:25:00.000Z' });
      const lo = L0 + 20 * MIN;
      const hi = L0 + 25 * MIN;
      await page.waitForTimeout(1_000);
      const at = (x: Body) => x.from === lo && x.to === hi;
      expect(b.prom.filter(at), 'PromQL range').toHaveLength(1);
      expect(
        b.range.filter((x) => at(x) && x.limit === 1000),
        'stream page',
      ).toHaveLength(1);
      expect(
        b.range.filter((x) => at(x) && x.limit === 1),
        'kind probe',
      ).toHaveLength(1);
      expect(b.volume.filter(at), 'volume').toHaveLength(1);
      await expect(rows(page, 'P2')).toHaveCount(2);
      await expect(rows(page, 'P2').nth(0).locator('[data-log-line]')).toHaveText(
        'checkout line D',
      );
      await expect(rows(page, 'P2').nth(1).locator('[data-log-line]')).toHaveText(
        'checkout line C',
      );
      await expect(readyFrame(page, 'P3')).toBeVisible();
    } finally {
      await deleteBoard(request, uid);
    }
  });

  test('e2e:board-logql-paging', async ({ page, request }, info) => {
    test.setTimeout(120_000);
    const b = bodies(page);
    const uid = await createBoard(request, `LQ3 ${info.project.name} ${crypto.randomUUID()}`, [
      { id: 'p-1', title: 'Paging', text: '{app="paging"}', grid: [0, 0, 12, 12], lang: 'logql' },
    ]);
    try {
      await page.goto(boardUrl(uid));
      await page.locator('html[data-shell-ready="true"]').waitFor();
      const list = rows(page, 'Paging');
      await expect(list.and(page.locator('[data-ord="0"]'))).toHaveCount(1);
      await page.waitForTimeout(1_000);
      // The panel prefetches 50 rows from the end: nothing more until the reader scrolls.
      expect(b.range).toHaveLength(1);
      expect(b.range[0]?.cursor).toBeUndefined();
      const region = panel(page, 'Paging').locator('[data-log-scroller]');
      const box = await region.boundingBox();
      if (box === null) throw new Error('no Log lines region');
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      const end = panel(page, 'Paging').getByText('End of results');
      let last = '';
      let setSize = '';
      for (let i = 0; i < 1_000; i++) {
        const mounted = await list.evaluateAll((els) =>
          els.map((e) => [
            Number(e.getAttribute('data-ord')),
            e.querySelector('[data-log-line]')?.textContent ?? '',
            e.getAttribute('aria-setsize') ?? '',
          ]),
        );
        for (const [ord, line, size] of mounted as [number, string, string][]) {
          if (ord === 1499) {
            last = line;
            setSize = size;
          }
        }
        if (last !== '' && (await end.isVisible())) break;
        await page.mouse.wheel(0, 600);
        await page.waitForTimeout(30);
      }
      await expect(end).toBeVisible();
      expect(b.range).toHaveLength(2);
      expect(b.range[1]?.cursor).toEqual(expect.any(String));
      expect(last).toBe('paging line 1499');
      expect(setSize).toBe('1500');
    } finally {
      await deleteBoard(request, uid);
    }
  });
});
