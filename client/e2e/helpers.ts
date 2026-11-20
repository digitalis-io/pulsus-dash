import { expect, type Page } from '@playwright/test';

/** 2026-11-19 13:03 London (GMT), the fixed "now" of the suite. */
export const T = Date.UTC(2026, 10, 19, 13, 3);
export const ORIGIN = 'http://localhost:4173';

export const enc = (iso: string): string => encodeURIComponent(iso);

/** Every page, by URL (the shell pages carry the default Context). */
export const SHELL_PAGES = [
  '/t/demo/boards',
  '/t/demo/board/b-1',
  '/t/demo/explore/metrics',
  '/t/demo/explore/logs',
  '/t/demo/admin',
] as const;
export const STANDALONE_PAGES = ['/nope', '/signed-out'] as const;
export const ALL_PAGES = [...SHELL_PAGES, ...STANDALONE_PAGES] as const;

/** Freezes `Date.now()` at `time` (timers keep running), then opens `url`. */
export async function open(page: Page, url: string, time: number = T): Promise<void> {
  await page.clock.setFixedTime(time);
  await page.goto(url);
  await waitReady(page, url);
}

export async function waitReady(page: Page, url: string): Promise<void> {
  if (url.startsWith('/t/')) {
    await page.locator('html[data-shell-ready="true"]').waitFor();
    await expect(page.getByRole('heading', { level: 1 })).not.toHaveText('');
  } else {
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  }
}

export function searchOf(page: Page): Record<string, string> {
  return Object.fromEntries(new URL(page.url()).searchParams);
}

export function timeTrigger(page: Page) {
  return page.getByRole('banner').getByRole('button', { name: /^(Last|\d|now)/ });
}

export async function openPicker(page: Page) {
  await timeTrigger(page).click();
  const dialog = page.getByRole('dialog', { name: 'Time range' });
  await dialog.getByRole('listbox', { name: 'Quick ranges' }).waitFor();
  return dialog;
}

export async function openUserMenu(page: Page) {
  await page.getByRole('button', { name: 'User menu: Ada Admin' }).click();
  const menu = page.getByRole('menu', { name: 'User menu: Ada Admin' });
  await menu.waitFor();
  return menu;
}
