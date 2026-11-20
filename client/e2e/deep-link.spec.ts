import { expect, test } from '@playwright/test';
import { open, openPicker, searchOf, timeTrigger } from './helpers.ts';

test.describe('e2e:deep-link', () => {
  test('time range from the URL, a quick range, and Back', async ({ page }) => {
    await open(page, '/t/demo/explore/metrics?from=now-6h&to=now');
    await expect(timeTrigger(page)).toHaveText(/^Last 6 hours/);
    const dialog = await openPicker(page);
    await dialog.getByRole('option', { name: 'Last 24 hours' }).click();
    await expect.poll(() => searchOf(page)['from']).toBe('now-24h');
    await expect(timeTrigger(page)).toHaveText(/^Last 24 hours/);
    await page.goBack();
    await expect(timeTrigger(page)).toHaveText(/^Last 6 hours/);
    expect(searchOf(page)['from']).toBe('now-6h');
  });

  test('an absolute range, the ] key, and Back', async ({ page }) => {
    const url =
      '/t/demo/board/b-1?from=2026-11-19T12:03:00.000Z&to=2026-11-19T13:03:00.000Z&refresh=off';
    await open(page, url);
    await expect(timeTrigger(page)).toHaveText(/19 Nov 2026, 12:03:00 – 13:03:00/);
    const original = page.url();
    await page.locator('main').focus();
    await page.keyboard.press(']');
    await expect(timeTrigger(page)).toHaveText(/19 Nov 2026, 13:03:00 – 14:03:00/);
    await page.goBack();
    await expect(timeTrigger(page)).toHaveText(/19 Nov 2026, 12:03:00 – 13:03:00/);
    expect(page.url()).toBe(original);
  });
});
