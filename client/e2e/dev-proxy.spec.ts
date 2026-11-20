import { expect, test } from '@playwright/test';
import { DEV_SERVER, E2E_VERSION, NEEDS_BFF, PREVIEW } from './bff.ts';

test.describe('e2e:bff-http-shell (vite dev proxied to the BFF)', () => {
  test.skip(PREVIEW, NEEDS_BFF);
  test.use({ baseURL: DEV_SERVER });

  test('npm run dev with VITE_API_MODE=http shows the server version', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/');
    await page.locator('html[data-shell-ready="true"]').waitFor({ timeout: 60_000 });
    await page.getByRole('button', { name: 'User menu: Local user' }).click();
    await page.getByRole('menuitem', { name: 'About Pulsus Dash' }).click();
    const about = page.getByRole('dialog', { name: 'About Pulsus Dash' });
    await expect(about.getByText(`Server version ${E2E_VERSION}`)).toBeVisible();
  });
});
