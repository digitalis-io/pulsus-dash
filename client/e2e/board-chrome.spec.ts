/**
 * `e2e:board-chrome` (#282 Part 2a §4.3; VL-004, VL-017, T08-019): board panels are elevated
 * cards with 8 px corners and 36 px headers; a failing stat panel takes the failing ring and glow,
 * its tag in the header and a count in the board's status line; the Edit toolbar is a tray and the
 * edited panel takes an accent outline; forced colours draw the borders.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { colour } from '../src/styles/tokens.ts';
import { open, openUserMenu } from './helpers.ts';

type Theme = 'dark' | 'light';

const TRANSPARENT = 'rgba(0, 0, 0, 0)';

async function css(l: Locator, prop: string): Promise<string> {
  return l.evaluate((e, p) => getComputedStyle(e).getPropertyValue(p), prop);
}

/** `rgb(r, g, b)` of a `#RRGGBB` token, as computed styles print it. */
function rgbOf(theme: Theme, key: 'failing'): string {
  const hex = colour[theme][key];
  const b = (i: number): number => parseInt(hex.slice(i, i + 2), 16);
  return `rgb(${String(b(1))}, ${String(b(3))}, ${String(b(5))})`;
}

const panel = (page: Page, title: string): Locator =>
  page
    .locator('[data-panel]')
    .filter({ has: page.getByRole('heading', { level: 3, name: title, exact: true }) });

async function setLight(page: Page): Promise<void> {
  const menu = await openUserMenu(page);
  await menu.getByRole('menuitemradio', { name: 'Light' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.keyboard.press('Escape');
}

test.describe('e2e:board-chrome', () => {
  test('panel cards, the failing ring, the tag and the status line', async ({ page }) => {
    for (const theme of ['dark', 'light'] as const) {
      await open(page, '/t/demo/board/b-1');
      if (theme === 'light') await setLight(page);
      const panels = page.locator('[data-panel]');
      await expect(panels.first()).toBeVisible();
      for (const title of ['Request rate', 'Error ratio', 'Errors']) {
        const p = panel(page, title);
        expect(await css(p, 'border-top-left-radius'), `${theme} ${title} radius`).toBe('8px');
        expect(await css(p, 'box-shadow'), `${theme} ${title} shadow`).toContain('inset');
        const header = p.getByRole('heading', { level: 3 }).locator('xpath=../..');
        expect((await header.boundingBox())?.height, `${theme} ${title} header`).toBe(36);
      }
      const ratio = panel(page, 'Error ratio');
      await expect(ratio).toHaveAttribute('data-stat-state', 'failing');
      await expect.poll(() => css(ratio, 'box-shadow')).toContain(rgbOf(theme, 'failing'));
      const tag = ratio.locator('[data-stat-chip] > [data-state]');
      await expect(tag).toHaveAttribute('data-state', 'failing');
      expect(await css(tag, 'border-top-left-radius'), `${theme} tag radius`).toBe('3px');
      await expect(page.locator('[data-board-health]')).toHaveText(/1 panel failing/);
    }
  });

  test('the Edit tray and the edited panel outline', async ({ page }) => {
    await open(page, '/t/demo/board/b-1');
    await page.getByRole('button', { name: 'Edit board' }).click();
    const tray = page.locator('[role="group"][data-mode="edit"]');
    await expect(tray).toBeVisible();
    expect(await css(tray, 'border-top-left-radius')).toBe('8px');
    await page.getByRole('button', { name: 'Panel menu: Request rate' }).click();
    await page.getByRole('menuitem', { name: 'Edit panel' }).click();
    await page.getByRole('dialog', { name: 'Edit panel' }).waitFor();
    const rate = panel(page, 'Request rate');
    await expect(rate).toHaveAttribute('data-selected', '');
    expect(await css(rate, 'outline-width')).toBe('3px');
    expect(await css(rate, 'outline-style')).toBe('solid');
  });

  test('forced colours draw the borders', async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    await open(page, '/t/demo/board/b-1');
    if (!(await page.evaluate(() => matchMedia('(forced-colors: active)').matches))) return;
    const ratio = panel(page, 'Error ratio');
    await expect(ratio).toHaveAttribute('data-stat-state', 'failing');
    expect(await css(ratio, 'border-top-width')).toBe('2px');
    for (const title of ['Request rate', 'Errors']) {
      expect(await css(panel(page, title), 'border-top-color'), title).not.toBe(TRANSPARENT);
    }
  });
});
