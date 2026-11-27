/**
 * The Board list widget in real browsers (plan #216 Part 2a §5; VIZ-053, T24-021 to T24-027,
 * VL-016), on boards created through the boards API of the http-mode BFF, in Chromium, Firefox and
 * WebKit. The list routes are answered by `page.route` (`boardListRoutes.ts`) with fixtures B and S.
 *
 * - `e2e:widget-board-list`: rows and Show more, the debounced search (one request, 250 ms after the
 *   last key, none for its prefixes), the announcement, hrefs with the time, a modified click.
 * - `e2e:widget-board-list (narrow, long tags)`: in a 2-column panel the title keeps half the row
 *   and the meta line gives way (T24-022).
 * - `e2e:widget-lists-a11y`: axe in each state (held, empty, error, stale, old server, truncated)
 *   in view and Edit mode, focus repair, the T24-025 Tab order, `aria-setsize`, reduced motion.
 * - Part 2b (plan #216 Part 2b §5): `e2e:widget-board-list (add flow)`, Add widget → Board list,
 *   its editor and preview, a board tag, Save and reload; `e2e:widget-lists-a11y (editor)`, axe and
 *   the Tab order of the editor over a populated preview and of the tags popover.
 */
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { B, findS, oldServer, wireOf } from '../src/widgets/boardList/fixtures.ts';
import { HTTP_BFF, NEEDS_BFF, PREVIEW } from './bff.ts';
import { deleteBoard } from './boardApi.ts';
import { listPanelSpec, routeBoardLists, type ListAnswer } from './boardListRoutes.ts';
import { axeSerious, BOARD_TIME } from './helpers.ts';

declare global {
  interface Window {
    __live?: string[];
  }
}

async function createListBoard(
  request: APIRequestContext,
  title: string,
  panels: readonly ReturnType<typeof listPanelSpec>[],
  tags?: readonly string[],
): Promise<string> {
  const r = await request.post('/api/dash/v1/boards', {
    data: { spec: { title, ...(tags === undefined ? {} : { tags }), panels, sections: [] } },
  });
  expect(r.status(), await r.text()).toBe(201);
  return ((await r.json()) as { uid: string }).uid;
}

const panel = (page: Page, title: string): Locator =>
  page
    .locator('[data-panel]')
    .filter({ has: page.getByRole('heading', { level: 3, name: title }) });
const rows = (p: Locator): Locator => p.locator('[data-board-list-rows] li > a');

/** Records every text the polite regions of the lists show, in order. */
async function recordLive(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__live = [];
    new MutationObserver(() => {
      for (const el of document.querySelectorAll('[data-board-list-live]')) {
        const text = el.textContent;
        if (text !== '' && window.__live?.at(-1) !== text) window.__live?.push(text);
      }
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
}

const findAnswer = (url: URL): ListAnswer => {
  const q = url.searchParams.get('q');
  const tag = url.searchParams.get('tag');
  return {
    body: wireOf(findS({ ...(q === null ? {} : { q }), ...(tag === null ? {} : { tag }) })),
  };
};

test.describe('Board list widget', () => {
  test.skip(PREVIEW, NEEDS_BFF);
  test.use({ baseURL: HTTP_BFF });

  test('e2e:widget-board-list', async ({ page, request, context }, info) => {
    const uid = await createListBoard(
      request,
      `E2E board list ${info.project.name} ${crypto.randomUUID()}`,
      [
        listPanelSpec('p-1', 'Starred', [0, 0, 6, 14]),
        listPanelSpec('p-2', 'Find', [6, 0, 6, 14], { mode: 'search', query: '' }),
      ],
    );
    try {
      await recordLive(page);
      const requests = await routeBoardLists(page, {
        starred: () => ({ body: wireOf(B) }),
        boards: findAnswer,
      });
      await page.goto(`/t/demo/board/${uid}?${BOARD_TIME}`);
      const starred = panel(page, 'Starred');
      await expect(rows(starred)).toHaveCount(10);
      await starred.getByRole('button', { name: 'Show more' }).click();
      await expect(rows(starred)).toHaveCount(12);
      await expect(rows(starred).nth(10)).toBeFocused();

      const find = panel(page, 'Find');
      await expect(rows(find)).toHaveCount(10);
      const field = find.getByRole('textbox', { name: 'Search boards' });
      await field.click();
      const before = requests.filter((r) => r.source === 'boards').length;
      let lastKey = 0;
      for (const c of 'check') {
        await field.press(c);
        lastKey = Date.now();
        await page.waitForTimeout(100);
      }
      await expect(rows(find)).toHaveCount(2);
      const finds = requests.filter((r) => r.source === 'boards').slice(before);
      expect(finds.map((r) => r.url.searchParams.get('q'))).toEqual(['check']);
      expect((finds[0]?.at ?? 0) - lastKey).toBeGreaterThanOrEqual(240);
      await expect
        .poll(() => page.evaluate(() => window.__live?.filter((s) => s === '2 boards').length))
        .toBe(1);
      await page.waitForTimeout(2500);
      expect(await page.evaluate(() => window.__live?.filter((s) => s === '2 boards').length)).toBe(
        1,
      );

      const href = new URL((await rows(starred).first().getAttribute('href')) ?? '', HTTP_BFF);
      expect(href.pathname).toBe('/t/demo/board/ck-1');
      expect(href.searchParams.get('from')).toBe('2026-01-01T00:00:00.000Z');
      expect(href.searchParams.get('to')).toBe('2026-01-01T01:00:00.000Z');
      const opened = context.waitForEvent('page');
      await rows(starred)
        .first()
        .click({ modifiers: ['ControlOrMeta'] });
      const tab = await opened;
      expect(new URL(tab.url()).pathname).toBe('/t/demo/board/ck-1');
      await tab.close();
      expect(new URL(page.url()).pathname).toBe(`/t/demo/board/${uid}`);
    } finally {
      await deleteBoard(request, uid);
    }
  });

  test('e2e:widget-board-list (narrow, long tags)', async ({ page, request }, info) => {
    const uid = await createListBoard(
      request,
      `E2E board list narrow ${info.project.name} ${crypto.randomUUID()}`,
      [listPanelSpec('p-1', 'Narrow', [0, 0, 2, 8], { mode: 'search', query: '' })],
    );
    const tags = [
      'team:payments-platform',
      'service:checkout-gateway',
      'region:europe-west',
      'tier:one',
    ];
    const page1 = {
      items: [
        {
          uid: 'long-1',
          title: 'Checkout payments overview for the platform team',
          version: 1,
          updatedAt: '2026-11-26T12:00:00Z',
          updatedBy: 'Ada',
          tags,
        },
      ],
      truncated: false,
      applied: {},
      tagsStale: 0,
    };
    try {
      await routeBoardLists(page, { boards: () => ({ body: wireOf(page1) }) });
      await page.goto(`/t/demo/board/${uid}?${BOARD_TIME}`);
      const link = rows(panel(page, 'Narrow')).first();
      await expect(link).toBeVisible();
      const li = link.locator('xpath=..');
      const [lw, rw] = await Promise.all([
        link.evaluate((e) => e.getBoundingClientRect().width),
        li.evaluate((e) => e.getBoundingClientRect().width),
      ]);
      // The title keeps at least half the row; the meta line gives way.
      // (less the gap between them)
      expect(lw).toBeGreaterThanOrEqual(rw / 2 - 16);
      expect(rw).toBeLessThan(400);
      const title = link.locator('span').first();
      expect(await title.evaluate((e) => e.getBoundingClientRect().width)).toBeGreaterThan(40);
      // Nothing of the row spills out of it.
      expect(await li.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
    } finally {
      await deleteBoard(request, uid);
    }
  });

  test('e2e:widget-lists-a11y', async ({ page, request }, info) => {
    test.setTimeout(120_000);
    const uid = await createListBoard(
      request,
      `E2E lists a11y ${info.project.name} ${crypto.randomUUID()}`,
      [
        listPanelSpec('p-1', 'Starred', [0, 0, 6, 14], { limit: 12 }),
        listPanelSpec('p-2', 'Bulk', [6, 0, 6, 14], { mode: 'search', query: 'bulk' }),
      ],
    );
    // B with the board itself as Payments, so one row is this board.
    const mine = { ...B, items: B.items.map((r) => (r.uid === 'pay' ? { ...r, uid } : r)) };
    let starred: () => ListAnswer = () => ({ body: wireOf(mine) });
    try {
      await routeBoardLists(page, { starred: () => starred(), boards: findAnswer });
      const open = async () => {
        await page.goto(`/t/demo/board/${uid}?${BOARD_TIME}`);
      };
      const refetch = async () => {
        await page.evaluate(() => {
          window.dispatchEvent(new Event('visibilitychange'));
        });
      };
      const list = panel(page, 'Starred');
      // In the pinned Firefox, an axe run on this board is followed by a content-process crash
      // (SIGSEGV) on a later step; without axe the steps pass. The DOM is engine-independent, so
      // axe runs in Chromium and WebKit, and every other step runs in all three.
      const axe = async (what: string) => {
        if (info.project.name === 'firefox') return;
        expect(await axeSerious(page), what).toEqual([]);
      };

      // Held 2 s: Loading….
      starred = () => ({ body: wireOf(mine), delayMs: 2000 });
      await open();
      await expect(list.getByText('Loading…')).toBeVisible();
      await axe('pending');
      await expect(rows(list)).toHaveCount(12);
      await axe('ok');
      await expect(list.getByRole('link', { name: 'Payments, this board' })).toHaveAttribute(
        'aria-current',
        'page',
      );
      await expect(rows(list).first().locator('xpath=..')).toHaveAttribute('aria-setsize', '12');
      const bulk = panel(page, 'Bulk');
      await expect(rows(bulk).first().locator('xpath=..')).toHaveAttribute('aria-setsize', '-1');

      // T24-025 Tab order: field → list → Show more → meter.
      const field = bulk.getByRole('textbox', { name: 'Search boards' });
      await field.focus();
      await page.keyboard.press('Tab');
      await expect(rows(bulk).first()).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(bulk.getByRole('button', { name: 'Show more' })).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(bulk.locator('[data-coverage-meter] button')).toBeFocused();

      // Same key, now empty, with focus in the list: the empty text takes focus.
      starred = () => ({ body: wireOf({ ...B, items: [] }) });
      await rows(list).nth(3).focus();
      await refetch();
      const empty = list.getByText('No starred boards. Star a board with ☆ in its header');
      await expect(empty).toBeFocused();
      await axe('empty');

      // A 500 with no rows: the error and Retry.
      starred = () => ({ status: 500 });
      await open();
      await expect(list.getByText("Couldn't load boards")).toBeVisible();
      await expect(list.getByRole('button', { name: 'Retry' })).toBeVisible();
      await axe('error');

      // Ok, then a refetch fails: the rows stay, stale.
      starred = () => ({ body: wireOf(mine) });
      await open();
      await expect(rows(list)).toHaveCount(12);
      starred = () => ({ status: 500 });
      await refetch();
      await expect(list.getByText(/^Couldn't refresh: showing boards from /)).toBeVisible({
        timeout: 15_000,
      });
      await expect(rows(list)).toHaveCount(12);
      await axe('stale');

      // An old server: setsize −1.
      starred = () => ({ body: oldServer(mine) });
      await open();
      await expect(rows(list)).toHaveCount(12);
      await expect(rows(list).first().locator('xpath=..')).toHaveAttribute('aria-setsize', '-1');
      await axe('old server');

      // Edit mode.
      await page.getByRole('button', { name: 'Edit board' }).click();
      await expect(rows(list)).toHaveCount(12);
      await axe('edit');

      // Reduced motion: a row new on a refresh has no animation.
      starred = () => ({ body: wireOf({ ...mine, items: mine.items.slice(0, 11) }) });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await open();
      await expect(rows(list)).toHaveCount(11);
      starred = () => ({ body: wireOf(mine) });
      await refetch();
      await expect(rows(list)).toHaveCount(12);
      const fresh = list.locator('[data-board-list-rows] li[data-new]');
      await expect(fresh).toHaveCount(1);
      expect(await fresh.evaluate((e) => getComputedStyle(e).animationName)).toBe('none');
    } finally {
      await deleteBoard(request, uid);
    }
  });

  test('e2e:widget-board-list (add flow)', async ({ page, request }, info) => {
    const uid = await createListBoard(
      request,
      `E2E board list add ${info.project.name} ${crypto.randomUUID()}`,
      [],
    );
    try {
      await routeBoardLists(page, { boards: findAnswer });
      await page.goto(`/t/demo/board/${uid}?${BOARD_TIME}`);
      await page.getByRole('button', { name: 'Edit board' }).click();
      await page.getByRole('button', { name: 'Add widget' }).click();
      await page.getByRole('menuitem', { name: 'Board list' }).click();
      const d = page.getByRole('dialog', { name: 'Edit board list' });
      await expect(d).toBeVisible();
      await d.getByRole('radio', { name: 'Search' }).click();
      await d.getByRole('textbox', { name: 'Search text' }).fill('check');
      await d.getByRole('textbox', { name: 'Rows' }).fill('5');
      const preview = d.getByRole('group', { name: 'Preview' });
      await expect(preview.locator('li')).toHaveCount(2);
      await d.getByRole('button', { name: 'Done' }).click();
      await expect(d).toBeHidden();

      await page.getByRole('button', { name: 'Tags', exact: true }).click();
      const tags = page.getByRole('dialog', { name: 'Board tags' });
      await tags.getByRole('textbox', { name: 'Add a tag' }).fill('team:payments');
      await tags.getByRole('textbox', { name: 'Add a tag' }).press('Enter');
      await expect(tags.getByRole('button', { name: 'Remove tag team:payments' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(tags).toBeHidden();
      await expect(page.getByRole('button', { name: 'Tags (1)' })).toBeVisible();
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByRole('status', { name: 'Save status' })).toHaveText('Saved');

      await page.reload();
      const list = panel(page, 'Untitled panel');
      await expect(rows(list)).toHaveCount(2);
      await expect(list.getByRole('textbox', { name: 'Search boards' })).toHaveValue('check');
      const got = await request.get(`/api/dash/v1/boards/${uid}`);
      expect(got.status()).toBe(200);
      const spec = (
        (await got.json()) as {
          spec: { tags?: string[]; panels: { vis: { options?: unknown } }[] };
        }
      ).spec;
      expect(spec.tags).toEqual(['team:payments']);
      expect(spec.panels[0]?.vis.options).toEqual({ mode: 'search', query: 'check', limit: 5 });
    } finally {
      await deleteBoard(request, uid);
    }
  });

  test('e2e:widget-lists-a11y (editor)', async ({ page, request }, info) => {
    const uid = await createListBoard(
      request,
      `E2E lists a11y editor ${info.project.name} ${crypto.randomUUID()}`,
      [listPanelSpec('p-1', 'Find', [0, 0, 6, 14], { mode: 'search', query: 'check' })],
      ['team:payments', 'noc'],
    );
    const axe = async (what: string) => {
      // #253: the pinned Firefox crashes after an axe run on a board.
      if (info.project.name === 'firefox') return;
      expect(await axeSerious(page), what).toEqual([]);
    };
    try {
      await routeBoardLists(page, { boards: findAnswer });
      await page.goto(`/t/demo/board/${uid}?${BOARD_TIME}`);
      await expect(rows(panel(page, 'Find'))).toHaveCount(2);
      await page.getByRole('button', { name: 'Edit board' }).click();
      await page.getByRole('button', { name: 'Panel menu: Find' }).click();
      await page.getByRole('menuitem', { name: 'Edit panel' }).click();
      const d = page.getByRole('dialog', { name: 'Edit board list' });
      await expect(d.getByRole('group', { name: 'Preview' }).locator('li')).toHaveCount(2);
      await axe('editor');

      // Title → Show → Search text → Rows → Order → Remove panel → Done.
      await d.getByRole('textbox', { name: 'Title' }).focus();
      const order = [
        d.getByRole('radio', { name: 'Search' }),
        d.getByRole('textbox', { name: 'Search text' }),
        d.getByRole('textbox', { name: 'Rows' }),
        d.getByRole('button', { name: /Order/ }),
        d.getByRole('button', { name: 'Remove panel' }),
        d.getByRole('button', { name: 'Done' }),
      ];
      for (const next of order) {
        await page.keyboard.press('Tab');
        await expect(next).toBeFocused();
      }
      await d.getByRole('button', { name: 'Done' }).click();
      await expect(d).toBeHidden();

      const trigger = page.getByRole('button', { name: 'Tags (2)' });
      await trigger.click();
      const pop = page.getByRole('dialog', { name: 'Board tags' });
      await expect(pop.getByRole('button', { name: 'Remove tag noc' })).toBeVisible();
      await axe('tags popover');
      await pop.getByRole('button', { name: 'Remove tag team:payments' }).focus();
      await page.keyboard.press('Tab');
      await expect(pop.getByRole('button', { name: 'Remove tag noc' })).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(pop.getByRole('textbox', { name: 'Add a tag' })).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(trigger).toBeFocused();
    } finally {
      await deleteBoard(request, uid);
    }
  });
});
