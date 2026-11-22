/**
 * `e2e:editor-ime` (T09-005; plan #63 Part C Appendix C.5, Chromium only): a CDP IME composition
 * in the Explore editor opens no completion popup while it lasts, and the popup follows once the
 * composition commits.
 */
import { expect, test } from '@playwright/test';
import { open } from './helpers.ts';

test('e2e:editor-ime: no completion during a composition', async ({ page }) => {
  await open(page, '/t/demo/explore/metrics?from=now-1h&to=now&refresh=off');
  const editor = page.getByRole('textbox', { name: 'PromQL query' });
  const popup = page.locator('.cm-tooltip-autocomplete');
  await editor.click();
  await page.keyboard.insertText('up{job="');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'a', selectionStart: 1, selectionEnd: 1 });
  for (let i = 0; i < 8; i++) {
    expect(await popup.count()).toBe(0);
    await page.waitForTimeout(50);
  }
  expect(await popup.count()).toBe(0);
  await cdp.send('Input.insertText', { text: 'a' });
  await expect(popup).toBeVisible({ timeout: 2_000 });
  await expect(popup.getByRole('option', { name: 'a', exact: true })).toBeVisible();
  await expect(editor).toHaveText('up{job="a');
});
