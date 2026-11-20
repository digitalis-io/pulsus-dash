import { expect, test, type Page } from '@playwright/test';
import { colour } from '../src/styles/tokens.ts';
import { open, openUserMenu } from './helpers.ts';

/** #RGB, #RGBA → #RRGGBB, #RRGGBBAA, upper case (the build minifies colour literals). */
function hex(v: string): string {
  const h = v.trim().toUpperCase();
  return /^#[0-9A-F]{3,4}$/.test(h) ? `#${h.slice(1).replace(/./g, (c) => c + c)}` : h;
}

async function cssVar(page: Page, name: string): Promise<string> {
  return hex(
    await page.evaluate(
      (n) => getComputedStyle(document.documentElement).getPropertyValue(n),
      name,
    ),
  );
}

test.describe('theme', () => {
  test('dark by default; Light applies every light token and persists; System follows the OS', async ({
    page,
  }) => {
    await open(page, '/t/demo/boards');
    expect(await cssVar(page, '--canvas')).toBe('#0B0D10');
    expect(await cssVar(page, '--surface-1')).toBe('#12151A');
    expect(await cssVar(page, '--surface-2')).toBe('#191D24');

    const menu = await openUserMenu(page);
    await menu.getByRole('menuitemradio', { name: 'Light' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    for (const [k, v] of Object.entries(colour.light)) {
      expect(await cssVar(page, `--${k}`), k).toBe(v);
      expect(v, k).not.toBe(colour.dark[k as keyof typeof colour.dark]);
    }
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    await page.emulateMedia({ colorScheme: 'light' });
    const again = await openUserMenu(page);
    await again.getByRole('menuitemradio', { name: 'System' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });
});
