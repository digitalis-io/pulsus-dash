import { expect, test } from '@playwright/test';
import { open, openPicker, searchOf, timeTrigger, waitReady } from './helpers.ts';

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

  test('explore query, vis and range', async ({ page }) => {
    await open(
      page,
      '/t/demo/explore/metrics?q=stub_metric&vis=bars&from=2026-11-19T12:00:00.000Z&to=2026-11-19T13:00:00.000Z',
    );
    await page.reload();
    await waitReady(page, '/t/demo/explore/metrics');
    const search = searchOf(page);
    expect(search['q']).toBe('stub_metric');
    expect(search['vis']).toBe('bars');
    expect(search['from']).toBe('2026-11-19T12:00:00.000Z');
    expect(search['to']).toBe('2026-11-19T13:00:00.000Z');
    await expect(page.getByRole('textbox', { name: 'PromQL query' })).toHaveText('stub_metric');
    await expect(page.getByRole('radio', { name: 'Bars' })).toBeChecked();
    await expect(timeTrigger(page)).toContainText('12:00');
    await expect
      .poll(() => page.locator('[data-chart-frame] canvas').getAttribute('aria-label'))
      .toMatch(/^Query result: stacked bar chart, 3 series/);
  });

  test('explore logs: query, order, wrap and range (plan #66 Part C)', async ({ page }) => {
    const url =
      '/t/demo/explore/logs?q=%7Bservice_name%3D%22stub%22%7D&dir=forward&wrap=on&from=2026-11-19T12:00:00.000Z&to=2026-11-19T13:00:00.000Z';
    await open(page, url);
    await page.reload();
    await waitReady(page, '/t/demo/explore/logs');
    const search = searchOf(page);
    expect(search['q']).toBe('{service_name="stub"}');
    expect(search['dir']).toBe('forward');
    expect(search['wrap']).toBe('on');
    expect(search['from']).toBe('2026-11-19T12:00:00.000Z');
    expect(search['to']).toBe('2026-11-19T13:00:00.000Z');
    await expect(page.getByRole('textbox', { name: 'LogQL query' })).toHaveText(
      '{service_name="stub"}',
    );
    await expect(page.getByRole('radio', { name: 'Oldest first' })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'Wrap lines' })).toBeChecked();
    await expect(timeTrigger(page)).toContainText('12:00');
  });
});
