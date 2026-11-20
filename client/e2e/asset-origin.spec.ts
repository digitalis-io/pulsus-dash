import { expect, test } from '@playwright/test';
import { ALL_PAGES, open, openPicker, openUserMenu, ORIGIN, SHELL_PAGES } from './helpers.ts';

test.describe('e2e:asset-origin', () => {
  test('every request goes to the app origin', async ({ page }) => {
    const urls: string[] = [];
    page.on('request', (r) => urls.push(r.url()));
    for (const url of ALL_PAGES) {
      await open(page, url);
      if ((SHELL_PAGES as readonly string[]).includes(url)) {
        await openPicker(page);
        await page.keyboard.press('Escape');
        const menu = await openUserMenu(page);
        await menu.getByRole('menuitem', { name: 'About Pulsus Dash' }).click();
        await page.getByRole('button', { name: 'Close' }).click();
      }
    }
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect(new URL(u).origin, u).toBe(ORIGIN);
  });
});
