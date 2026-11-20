import { expect, test, type Page } from '@playwright/test';
import { E2E_VERSION, HTTP_BFF, NEEDS_BFF, PREVIEW } from './bff.ts';

/** Collects console errors and page errors. */
function errorsOf(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

test.describe('e2e:bff-http-shell', () => {
  test.skip(PREVIEW, NEEDS_BFF);
  test.use({ baseURL: HTTP_BFF });

  test('the http build bootstraps from the BFF', async ({ page }) => {
    const errors = errorsOf(page);
    await page.goto('/');
    await page.locator('html[data-shell-ready="true"]').waitFor();
    expect(new URL(page.url()).pathname).toBe('/t/demo/boards');

    const sidebar = page.locator('aside');
    await expect(sidebar.getByText('Data source: demo · Not checked')).toBeVisible();

    await page.getByRole('button', { name: 'User menu: Local user' }).click();
    const menu = page.getByRole('menu', { name: 'User menu: Local user' });
    await menu.waitFor();
    await expect(menu.getByRole('menuitem', { name: 'Sign out' })).toHaveCount(0);
    await menu.getByRole('menuitem', { name: 'About Pulsus Dash' }).click();
    const about = page.getByRole('dialog', { name: 'About Pulsus Dash' });
    await expect(about.getByText(`Server version ${E2E_VERSION}`)).toBeVisible();
    expect(errors).toEqual([]);
  });
});
