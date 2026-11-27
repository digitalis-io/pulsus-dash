/**
 * The Board list widget in real browsers (plan #216 Part 2a §5; VIZ-053, T24-021 to T24-027,
 * VL-016), on boards created through the boards API of the http-mode BFF, in Chromium, Firefox and
 * WebKit. The list routes are answered by `page.route` (`boardListRoutes.ts`) with fixtures B and S.
 *
 * - `e2e:widget-board-list`: rows and Show more, the debounced search (one request, 250 ms after the
 *   last key, none for its prefixes), the announcement, hrefs with the time, a modified click.
 * - `e2e:widget-lists-a11y`: axe in each state (held, empty, error, stale, old server, truncated)
 *   in view and Edit mode, focus repair, the T24-025 Tab order, `aria-setsize`, reduced motion.
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
): Promise<string> {
  const r = await request.post('/api/dash/v1/boards', {
    data: { spec: { title, panels, sections: [] } },
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
      const axe = async (what: string) => {
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
});
