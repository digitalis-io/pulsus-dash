import { expect, test, type Page } from '@playwright/test';
import { open, openPicker, SHELL_PAGES, timeTrigger } from './helpers.ts';

const nav = (page: Page) => page.getByRole('navigation', { name: 'Main' });

async function widthOf(page: Page): Promise<number> {
  return (await nav(page).boundingBox())?.width ?? 0;
}

async function noHorizontalOverflow(page: Page, viewport: number): Promise<void> {
  const o = await page.evaluate(() => {
    const header = document.querySelector('header');
    return {
      doc: document.documentElement.scrollWidth,
      header: header === null ? 0 : header.scrollWidth - header.clientWidth,
    };
  });
  expect(o.doc).toBe(viewport);
  expect(o.header).toBe(0);
}

test.describe('e2e:app-layout', () => {
  test('sidebar collapses to 56 px, persists, and shows tooltips', async ({ page }) => {
    await open(page, '/t/demo/boards');
    expect(await widthOf(page)).toBe(240);
    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    await expect.poll(() => widthOf(page)).toBe(56);
    await page.reload();
    await page.locator('html[data-shell-ready="true"]').waitFor();
    expect(await widthOf(page)).toBe(56);
    await nav(page).getByRole('link', { name: 'Metrics' }).focus();
    await expect(page.getByRole('tooltip', { name: 'Metrics' })).toBeVisible();
  });

  for (const url of [...SHELL_PAGES, '/t/demo/board/b-3']) {
    test(`header geometry on ${url}`, async ({ page }) => {
      await open(page, url);
      const header = await page.getByRole('banner').boundingBox();
      expect(header?.height).toBe(56);
      const top = await page.locator('aside > div').first().boundingBox();
      expect(top?.height).toBe(56);
      expect((top?.y ?? 0) + (top?.height ?? 0)).toBe((header?.y ?? 0) + (header?.height ?? 0));
      const time = await timeTrigger(page).boundingBox();
      const refresh = await page.getByRole('group', { name: 'Refresh' }).boundingBox();
      const user = await page.getByRole('button', { name: 'User menu: Ada Admin' }).boundingBox();
      expect(time && refresh && user).toBeTruthy();
      if (!time || !refresh || !user) return;
      expect(time.x).toBeLessThan(refresh.x);
      expect(refresh.x).toBeLessThan(user.x);
      expect(user.x + user.width).toBeLessThanOrEqual(1440 - 24);
      expect(await page.locator('main').evaluate((m) => getComputedStyle(m).padding)).toBe('24px');
      await noHorizontalOverflow(page, 1440);
      if (url.endsWith('/b-3')) {
        const h1 = page.getByRole('heading', { level: 1 });
        const t = await h1.evaluate((e) => ({
          overflow: e.scrollWidth > e.clientWidth,
          ellipsis: getComputedStyle(e).textOverflow,
          title: e.getAttribute('title'),
        }));
        expect(t).toEqual({
          overflow: true,
          ellipsis: 'ellipsis',
          title: 'Edge gateway, eu-west-1: p99 latency by pod and region after the last deploy',
        });
      }
    });
  }

  test('the absolute window shows from 1520 px', async ({ page }) => {
    const absolute = () => timeTrigger(page).getByText('12:03 – 13:03 GMT');
    await page.setViewportSize({ width: 1519, height: 900 });
    await open(page, '/t/demo/boards');
    await expect(absolute()).toBeHidden();
    await noHorizontalOverflow(page, 1519);
    await page.setViewportSize({ width: 1520, height: 900 });
    await expect(absolute()).toBeVisible();
    await noHorizontalOverflow(page, 1520);

    await open(
      page,
      '/t/demo/boards?from=2026-11-19T12%3A03%3A00.000Z&to=2026-11-19T13%3A03%3A00.000Z&refresh=off',
    );
    await expect(timeTrigger(page)).toHaveText(/19 Nov 2026, 12:03:00 – 13:03:00/);
    await expect(timeTrigger(page).getByText('GMT', { exact: false })).toHaveCount(0);
    await page.setViewportSize({ width: 1519, height: 900 });
    await expect(timeTrigger(page).getByText('GMT', { exact: false })).toHaveCount(0);
  });

  test('navigation keeps the Context and marks one current item', async ({ page }) => {
    await open(page, '/t/demo/boards?from=now-6h&to=now&refresh=30s');
    for (const [name, path] of [
      ['Metrics', '/t/demo/explore/metrics'],
      ['Logs', '/t/demo/explore/logs'],
      ['Admin', '/t/demo/admin'],
      ['Boards', '/t/demo/boards'],
    ] as const) {
      await nav(page).getByRole('link', { name, exact: true }).click();
      await expect(page).toHaveURL((u) => u.pathname === path);
      expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual({
        from: 'now-6h',
        to: 'now',
        refresh: '30s',
      });
      const current = page.locator('[aria-current="page"]');
      await expect(current).toHaveCount(1);
      await expect(current).toHaveAccessibleName(name);
    }
  });

  test('the picker opens without overflow', async ({ page }) => {
    await open(page, '/t/demo/boards');
    await openPicker(page);
    await noHorizontalOverflow(page, 1440);
  });
});
