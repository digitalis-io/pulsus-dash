import { expect, test } from '@playwright/test';
import { productionHeaders } from '../config/headers.ts';
import {
  ALL_PAGES,
  EXPLORE_RESULT,
  LOGS_RESULT,
  open,
  openPicker,
  openUserMenu,
  SHELL_PAGES,
} from './helpers.ts';

declare global {
  interface Window {
    __cspViolations: string[];
  }
}

test.describe('e2e:csp-violations', () => {
  test('no CSP or Trusted Types violation on any page or overlay', async ({ page }) => {
    // Every page and overlay, then Explore with the editor, its popup and the picker.
    test.setTimeout(60_000);
    await page.addInitScript(() => {
      window.__cspViolations = [];
      document.addEventListener('securitypolicyviolation', (e) => {
        window.__cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`);
      });
    });
    const console: string[] = [];
    page.on('console', (m) => {
      if (/Content[- ]Security[- ]Policy|Trusted Type/i.test(m.text())) console.push(m.text());
    });

    for (const url of ALL_PAGES) {
      await open(page, url);
      if ((SHELL_PAGES as readonly string[]).includes(url)) {
        const dialog = await openPicker(page);
        await dialog.getByRole('grid').waitFor();
        await page.keyboard.press('Escape');
        const menu = await openUserMenu(page);
        await menu.getByRole('menuitem', { name: 'About Pulsus Dash' }).click();
        await page
          .getByRole('dialog', { name: 'About Pulsus Dash' })
          .getByRole('button', { name: 'Close' })
          .click();
      }
      expect(await page.evaluate(() => window.__cspViolations), url).toEqual([]);
    }

    // Explore with the editor, its completion popup and the metric picker (plan #63 C.7).
    await open(page, EXPLORE_RESULT);
    await expect(page.getByRole('table').getByRole('row')).toHaveCount(4);
    await page.getByRole('textbox', { name: 'PromQL query' }).click();
    await page.keyboard.press('End');
    await page.keyboard.press('Control+Space');
    await page.locator('.cm-tooltip-autocomplete').waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('combobox', { name: 'Metric' }).focus();
    await page.getByRole('listbox').waitFor();
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => window.__cspViolations), EXPLORE_RESULT).toEqual([]);

    // Explore › Logs with a result: the LogQL editor's completion popup and Wrap lines (plan #66
    // Part C).
    await open(page, LOGS_RESULT);
    await expect(
      page.getByRole('list', { name: 'Log lines' }).locator('[data-log-row]'),
    ).not.toHaveCount(0);
    await page.getByRole('textbox', { name: 'LogQL query' }).click();
    // Inside the selector, after `{`: the label names.
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Control+Space');
    await page.locator('.cm-tooltip-autocomplete').waitFor();
    await page.keyboard.press('Escape');
    // The checkbox's input is visually hidden: press its label.
    const wrapLabel = page.getByText('Wrap lines', { exact: true });
    await wrapLabel.click();
    await expect(page.getByRole('checkbox', { name: 'Wrap lines' })).toBeChecked();
    await wrapLabel.click();
    await expect(page.getByRole('checkbox', { name: 'Wrap lines' })).not.toBeChecked();
    expect(await page.evaluate(() => window.__cspViolations), LOGS_RESULT).toEqual([]);

    // The board panel editor with the PromQL editor, its popup and the picker (plan #64 A.3).
    await open(page, '/t/demo/board/b-1');
    await page.getByRole('button', { name: 'Panel menu: Request rate' }).click();
    await page.getByRole('menuitem', { name: 'Edit panel' }).click();
    const d = page.getByRole('dialog', { name: 'Edit panel' });
    await d.getByRole('textbox', { name: 'Query' }).click();
    await page.keyboard.press('End');
    await page.keyboard.press('Control+Space');
    await page.locator('.cm-tooltip-autocomplete').waitFor();
    await page.keyboard.press('Escape');
    await d.getByRole('combobox', { name: 'Metric' }).focus();
    await page.getByRole('listbox').waitFor();
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => window.__cspViolations), 'board panel editor').toEqual([]);
    expect(console).toEqual([]);
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);

    // A navigation's Accept: the BFF serves index.html only to requests that accept HTML.
    const response = await page.request.get('/t/demo/boards', { headers: { Accept: 'text/html' } });
    const headers = response.headers();
    for (const [k, v] of Object.entries(productionHeaders))
      expect(headers[k.toLowerCase()], k).toBe(v);
  });
});
