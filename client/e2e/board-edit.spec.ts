/**
 * `e2e:board-edit-save` and `e2e:board-tall` (plan #61 Part B §5.3, Appendix B-A §A.4): the board
 * editor against the http-mode BFF and its database, in Chromium, Firefox and WebKit.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { cellPx } from '../src/boards/layout.ts';
import { HTTP_BFF, NEEDS_BFF, PREVIEW } from './bff.ts';

const API = '/api/dash/v1/boards';
/** The window the fake's data transcripts were recorded on (Explore's `W0`). */
const W0_TIME = 'from=2026-01-01T00%3A00%3A00.000Z&to=2026-01-01T01%3A00%3A00.000Z&refresh=off';

/** Collects console errors and page errors. */
function errorsOf(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

function panel(page: Page, title: string) {
  return page.locator('[data-panel]').filter({
    has: page.getByRole('heading', { level: 3, name: title, exact: true }),
  });
}

function grid(page: Page, title: string): Promise<string | null> {
  return panel(page, title).getAttribute('data-grid');
}

async function remove(request: APIRequestContext, uid: string): Promise<void> {
  const r = await request.get(`${API}/${uid}`);
  if (r.status() === 404) return;
  const { etag } = (await r.json()) as { etag: string };
  const d = await request.delete(`${API}/${uid}`, { headers: { 'If-Match': `"${etag}"` } });
  expect([204, 404]).toContain(d.status());
}

/** Drags with the mouse from the centre of `from` by (dx, dy) px in 10 steps. */
async function dragBy(
  page: Page,
  box: { x: number; y: number; width: number; height: number },
  dx: number,
  dy: number,
): Promise<void> {
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 10 });
  await page.mouse.up();
}

test.describe('e2e:board-edit-save', () => {
  test.skip(PREVIEW, NEEDS_BFF);
  test.use({ baseURL: HTTP_BFF });

  test('create, lay out, save, reload and guard', async ({ page, request }, testInfo) => {
    test.setTimeout(120_000);
    const errors = errorsOf(page);
    const title = `E2E board ${testInfo.project.name} w${String(testInfo.workerIndex)} ${crypto.randomUUID()}`;
    let uid: string | null = null;
    // Tall enough that C's resize handle is clear of the bottom edge, where react-grid-layout
    // scrolls the page during a drag and so adds to the pointer's travel.
    // Wide enough that a 6-column panel gets the 5 s step the fake's histogram transcript is on.
    await page.setViewportSize({ width: 1920, height: 1600 });
    try {
      // 1. Create.
      await page.goto('/t/demo/boards');
      await page.locator('html[data-shell-ready="true"]').waitFor();
      await page.getByRole('button', { name: 'New board' }).click();
      const dialog = page.getByRole('dialog', { name: 'New board' });
      await dialog.getByRole('textbox', { name: 'Name' }).fill(title);
      await dialog.getByRole('button', { name: 'Create' }).click();
      await expect(page).toHaveURL(/\/t\/demo\/board\/[0-9a-z]{14}\?/);
      uid = new URL(page.url()).pathname.split('/').at(-1) ?? null;
      expect(uid).toMatch(/^[0-9a-z]{14}$/);
      await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(`${title} (editing)`);
      // On the window of the fake's data transcripts (plan #64 A.5), so the panels' queries draw.
      await page.goto(`${new URL(page.url()).pathname}?${W0_TIME}`);
      await page.getByRole('button', { name: 'Edit board' }).click();
      await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();

      // 2. Three panels.
      const editor = page.getByRole('dialog', { name: 'Edit panel' });
      // Each with a query the fake answers (plan #64 A.5), so the panels draw after the reload.
      for (const [name, vis, text] of [
        ['A', 'Line', 'node_memory_free_bytes'],
        ['B', 'Stat', 'node_memory_free_bytes'],
        ['C', 'Heatmap', 'sum by (le) (rate(http_request_duration_seconds_bucket[5m]))'],
      ] as const) {
        await page.getByRole('button', { name: 'Add panel', exact: true }).click();
        await editor.getByRole('textbox', { name: 'Title' }).fill(name);
        await editor.getByRole('textbox', { name: 'Query' }).click();
        await page.keyboard.insertText(text);
        await page.keyboard.press('Shift+Enter');
        await editor.getByRole('button', { name: /Visualisation$/ }).click();
        await page.getByRole('option', { name: vis, exact: true }).click();
        await editor.getByRole('button', { name: 'Done' }).click();
        await expect(editor).toBeHidden();
      }
      expect(await grid(page, 'A')).toBe('0,0,6,8');
      expect(await grid(page, 'B')).toBe('6,0,6,8');
      expect(await grid(page, 'C')).toBe('0,8,6,8');

      // 3. Move C to column 7 with the pointer.
      const gridBox = await page.locator('[data-board-grid]').first().boundingBox();
      const cell = cellPx(gridBox?.width ?? 0);
      await panel(page, 'C').evaluate((e) => {
        e.scrollIntoView({ block: 'center' });
      });
      const header = await panel(page, 'C').getByRole('heading', { level: 3 }).boundingBox();
      if (header === null) throw new Error('no header');
      await dragBy(page, header, 6 * (cell + 16), 0);
      await expect.poll(() => grid(page, 'C')).toBe('6,8,6,8');

      // 4. Resize C to 6 × 10.
      const handle = page
        .locator('.react-grid-item')
        .filter({ has: page.getByRole('heading', { level: 3, name: 'C', exact: true }) })
        .locator('.react-resizable-handle');
      // Centred, so the drag stays clear of the grid's edge auto-scroll.
      await handle.evaluate((e) => {
        e.scrollIntoView({ block: 'center' });
      });
      const hb = await handle.boundingBox();
      if (hb === null) throw new Error('no resize handle');
      await dragBy(page, hb, 0, 2 * (40 + 16));
      await expect.poll(() => grid(page, 'C')).toBe('6,8,6,10');

      // 5. Save.
      await page.keyboard.press('ControlOrMeta+S');
      await expect(page.getByRole('status', { name: 'Save status' })).toHaveText('Saved');
      await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();

      // 6. Reload: View mode, the same layout, and the server agrees.
      await page.reload();
      await expect(page.getByRole('button', { name: 'Edit board' })).toBeVisible();
      const want = {
        A: ['0,0,6,8', 'line'],
        B: ['6,0,6,8', 'stat'],
        C: ['6,8,6,10', 'heatmap'],
      } as const;
      for (const [name, [g, vis]] of Object.entries(want)) {
        await expect(panel(page, name)).toHaveAttribute('data-grid', g);
        await expect(panel(page, name)).toHaveAttribute('data-vis', vis);
        await expect(panel(page, name)).toHaveAttribute('data-panel-state', 'frame');
      }
      const stored = (await (await request.get(`${API}/${uid ?? ''}`)).json()) as {
        spec: {
          panels: { title: string; grid: Record<string, number>; vis: { kind: string } }[];
        };
      };
      expect(
        stored.spec.panels.map((p) => [
          p.title,
          [p.grid['x'], p.grid['y'], p.grid['w'], p.grid['h']].join(','),
          p.vis.kind,
        ]),
      ).toEqual(Object.entries(want).map(([n, [g, v]]) => [n, g, v]));

      // 7. The guard keeps unsaved work.
      const nav = page.getByRole('navigation', { name: 'Main' });
      await page.getByRole('button', { name: 'Edit board' }).click();
      await page.getByRole('button', { name: 'Add panel', exact: true }).click();
      await page.keyboard.press('Escape');
      await expect(editor).toBeHidden();
      const url = page.url();
      await nav.getByRole('link', { name: 'Boards', exact: true }).click();
      const guard = page.getByRole('dialog', { name: 'Discard unsaved changes?' });
      await guard.getByRole('button', { name: 'Keep editing' }).click();
      expect(page.url()).toBe(url);
      await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled();
      await expect(page.locator('[data-panel]')).toHaveCount(4);

      // 8. Discard and leave.
      await nav.getByRole('link', { name: 'Boards', exact: true }).click();
      await guard.getByRole('button', { name: 'Discard changes' }).click();
      await expect(page).toHaveURL((u) => u.pathname === '/t/demo/boards');
      await expect(
        page.getByRole('table', { name: 'All boards' }).getByRole('link', { name: title }),
      ).toBeVisible();
      expect(errors).toEqual([]);
    } finally {
      if (uid !== null) await remove(request, uid);
    }
  });
});

test.describe('e2e:board-tall', () => {
  test.skip(PREVIEW, NEEDS_BFF);
  test.use({ baseURL: HTTP_BFF });

  test('a panel at the last row renders in both modes', async ({ page, request }, testInfo) => {
    test.setTimeout(120_000);
    const title = `E2E tall ${testInfo.project.name} w${String(testInfo.workerIndex)} ${crypto.randomUUID()}`;
    const p = (id: string, name: string, y: number, h: number) => ({
      id,
      title: name,
      grid: { x: 0, y, w: 6, h },
      query: { lang: 'promql', text: 'node_memory_free_bytes' },
      vis: { kind: 'line' },
    });
    const created = await request.post(API, {
      data: {
        spec: { title, panels: [p('p-1', 'Near', 0, 8), p('p-2', 'Far', 9999, 100)], sections: [] },
      },
    });
    expect(created.status()).toBe(201);
    const { uid } = (await created.json()) as { uid: string };
    try {
      await page.goto(`/t/demo/board/${uid}`);
      await page.locator('html[data-shell-ready="true"]').waitFor();
      const far = panel(page, 'Far');
      const container = page.locator('[data-board-grid]').first();
      const check = async (): Promise<void> => {
        await far.scrollIntoViewIfNeeded();
        const g = await container.boundingBox();
        const b = await far.boundingBox();
        if (g === null || b === null) throw new Error('no box');
        // 40 px rows and 12 px gaps (#282 Part 2a).
        expect(Math.abs(b.y - g.y - 9999 * 52)).toBeLessThanOrEqual(1);
        expect(Math.abs(b.height - (100 * 40 + 99 * 12))).toBeLessThanOrEqual(1);
      };
      await expect(far).toHaveAttribute('data-grid', '0,9999,6,100');
      await check();

      await page.getByRole('button', { name: 'Edit board' }).click();
      await expect(page.locator('[data-drag-handle]')).toHaveCount(2);
      await check();
      const header = await far.getByRole('heading', { level: 3 }).boundingBox();
      if (header === null) throw new Error('no header');
      await dragBy(page, header, 0, 52);
      await expect(far).toHaveAttribute('data-grid', '0,9999,6,100');
    } finally {
      await remove(request, uid);
    }
  });
});

declare global {
  interface Window {
    __copied: string[];
  }
}

test.describe('e2e:board-sections', () => {
  test.skip(PREVIEW, NEEDS_BFF);
  test.use({ baseURL: HTTP_BFF });

  test('collapsed sections, URL overrides and saved state', async ({
    page,
    request,
    browser,
  }, testInfo) => {
    test.setTimeout(120_000);
    const errors = errorsOf(page);
    const title = `E2E sections ${testInfo.project.name} w${String(testInfo.workerIndex)} ${crypto.randomUUID()}`;
    const p = (id: string, name: string, x: number) => ({
      id,
      title: name,
      grid: { x, y: 0, w: 6, h: 8 },
      query: { lang: 'promql', text: 'node_memory_free_bytes' },
      vis: { kind: 'line' },
    });
    const created = await request.post(API, {
      data: {
        spec: {
          title,
          panels: [p('p-1', 'Top', 0)],
          sections: [
            {
              id: 's-1',
              title: 'Collapsed group',
              collapsed: true,
              panels: [p('p-2', 'Hidden', 0), p('p-3', 'Hidden too', 6)],
            },
            { id: 's-2', title: 'Open group', collapsed: false, panels: [p('p-4', 'Shown', 0)] },
          ],
        },
      },
    });
    expect(created.status()).toBe(201);
    const { uid } = (await created.json()) as { uid: string };
    const url = `/t/demo/board/${uid}?${W0_TIME}`;
    const toggle = (pg: Page, name: string) =>
      pg.getByRole('button', { name, exact: true }).and(pg.locator('[aria-expanded]'));
    const stored = async () =>
      (
        (await (await request.get(`${API}/${uid}`)).json()) as {
          spec: {
            sections: {
              id: string;
              title: string;
              collapsed: boolean;
              panels: { grid: Record<string, number> }[];
            }[];
          };
        }
      ).spec.sections;
    /** Opens `target` in a new context (empty storage), runs `check`, closes the context. */
    const fresh = async (target: string, check: (pg: Page) => Promise<void>): Promise<void> => {
      const c = await browser.newContext({
        baseURL: HTTP_BFF,
        viewport: { width: 1440, height: 900 },
      });
      try {
        const pg = await c.newPage();
        await pg.goto(target);
        await pg.locator('html[data-shell-ready="true"]').waitFor();
        await check(pg);
      } finally {
        await c.close();
      }
    };
    const expanded = async (pg: Page) => {
      await expect(toggle(pg, 'Collapsed group')).toHaveAttribute('aria-expanded', 'true');
      await expect(panel(pg, 'Hidden')).toBeVisible();
      await expect(toggle(pg, 'Open group')).toHaveAttribute('aria-expanded', 'false');
      await expect(panel(pg, 'Shown')).toHaveCount(0);
    };
    const saved = async (pg: Page) => {
      await expect(toggle(pg, 'Collapsed group')).toHaveAttribute('aria-expanded', 'false');
      await expect(panel(pg, 'Hidden')).toHaveCount(0);
      await expect(toggle(pg, 'Open group')).toHaveAttribute('aria-expanded', 'true');
      await expect(panel(pg, 'Shown')).toBeVisible();
    };
    await page.addInitScript(() => {
      window.__copied = [];
      const writeText = (s: string): Promise<void> => {
        window.__copied.push(s);
        return Promise.resolve();
      };
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    });
    try {
      // 1. The saved state: the collapsed section renders no panels.
      await page.goto(url);
      await page.locator('html[data-shell-ready="true"]').waitFor();
      await expect(panel(page, 'Top')).toBeVisible();
      await expect(panel(page, 'Shown')).toBeVisible();
      await expect(panel(page, 'Hidden')).toHaveCount(0);
      await expect(page.locator('[data-section="s-1"]').getByText('2 panels')).toBeVisible();
      await expect(toggle(page, 'Collapsed group')).toHaveAttribute('aria-expanded', 'false');

      // 2. View toggles: URL overrides.
      await toggle(page, 'Collapsed group').click();
      await toggle(page, 'Open group').click();
      await expect(panel(page, 'Hidden')).toBeVisible();
      await expect(panel(page, 'Hidden too')).toBeVisible();
      await expect(panel(page, 'Hidden')).toHaveAttribute('data-panel-state', 'frame');
      await expect(panel(page, 'Hidden too')).toHaveAttribute('data-panel-state', 'frame');
      await expect(panel(page, 'Shown')).toHaveCount(0);
      await expect
        .poll(() => {
          const q = new URL(page.url()).searchParams;
          return [q.getAll('collapse'), q.getAll('expand')];
        })
        .toEqual([['s-2'], ['s-1']]);

      // 3. Reload: the same, and nothing was saved.
      await page.reload();
      await page.locator('html[data-shell-ready="true"]').waitFor();
      await expanded(page);
      expect((await stored()).map((s) => s.collapsed)).toEqual([true, false]);

      // 4. Copy link reproduces the view in a fresh context.
      await page.getByRole('button', { name: 'Share' }).click();
      const share = page.getByRole('dialog', { name: 'Share board' });
      // The checkbox's input is visually hidden: press its label.
      await share.getByText('Keep relative', { exact: true }).click();
      await expect(share.getByRole('checkbox', { name: 'Keep relative' })).toBeChecked();
      await share.getByRole('button', { name: 'Copy link' }).click();
      await expect.poll(() => page.evaluate(() => window.__copied.length)).toBe(1);
      const copied = await page.evaluate(() => window.__copied.at(-1) ?? '');
      await page.keyboard.press('Escape');
      await fresh(copied, expanded);

      // 5. The plain URL in a fresh context: the saved state.
      await fresh(url, saved);

      // 6. Edit drops the overrides and shows the saved state.
      await page.getByRole('button', { name: 'Edit board' }).click();
      await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
      await expect.poll(() => new URL(page.url()).search).not.toMatch(/collapse=|expand=/);
      await expect(toggle(page, 'Collapsed group')).toHaveAttribute('aria-expanded', 'false');
      await expect(toggle(page, 'Open group')).toHaveAttribute('aria-expanded', 'true');

      // 7. An Edit collapse and a new section are saved.
      await toggle(page, 'Collapsed group').click();
      await page.getByRole('button', { name: 'Add section' }).click();
      await page.getByRole('textbox', { name: 'Section 3 title' }).fill('Second');
      await page.getByRole('button', { name: 'Add panel to Second' }).click();
      const editor = page.getByRole('dialog', { name: 'Edit panel' });
      await page.keyboard.press('ControlOrMeta+S');
      await expect(editor.getByRole('status', { name: 'Save status' })).toHaveText('Saved');
      await page.keyboard.press('Escape');
      await expect(editor).toBeHidden();

      // 8. Reload: View mode shows what was saved, and the server agrees.
      await page.reload();
      await page.locator('html[data-shell-ready="true"]').waitFor();
      await expect(page.getByRole('button', { name: 'Edit board' })).toBeVisible();
      await expect(toggle(page, 'Collapsed group')).toHaveAttribute('aria-expanded', 'true');
      await expect(page.locator('[data-section="s-1"] [data-panel]')).toHaveCount(2);
      await expect(page.locator('[data-section="s-3"]').getByText('1 panel')).toBeVisible();
      const sections = await stored();
      expect(sections[0]?.collapsed).toBe(false);
      expect(sections[2]).toMatchObject({ id: 's-3', title: 'Second', collapsed: false });
      expect(sections[2]?.panels.map((x) => x.grid)).toEqual([{ x: 0, y: 0, w: 6, h: 8 }]);
      expect(errors).toEqual([]);
    } finally {
      await remove(request, uid);
    }
  });
});
