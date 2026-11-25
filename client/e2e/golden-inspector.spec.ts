/**
 * `golden:inspector` (plan #192 §5, T25-013): the Inspector open and collapsed in dark, light and
 * forced colours. Chromium only (pixel goldens, T05-005), like `golden-gallery.spec.ts`.
 */
import { expect, test } from '@playwright/test';
import { HTTP_BFF, NEEDS_BFF, PREVIEW } from './bff.ts';
import { aside, boardUrl, inspectP, K_FROM, K_TO, KINDS, withBoard } from './inspectorBoards.ts';

test.describe('golden:inspector (fake)', () => {
  test.skip(PREVIEW, NEEDS_BFF);
  test.use({ baseURL: HTTP_BFF, viewport: { width: 1440, height: 900 } });

  test('golden:inspector', async ({ page, request }) => {
    test.setTimeout(120_000);
    await withBoard(
      page,
      request,
      'inspector kinds',
      KINDS,
      (u) => boardUrl(u, K_FROM, K_TO),
      async () => {
        for (const theme of ['dark', 'light', 'forced'] as const) {
          if (theme === 'forced') await page.emulateMedia({ forcedColors: 'active' });
          else {
            await page.emulateMedia({ forcedColors: 'none' });
            await page.evaluate((t) => {
              document.documentElement.dataset['theme'] = t;
            }, theme);
          }
          await inspectP(page);
          const sheet = aside(page);
          if (theme === 'forced') {
            const bg = await sheet.evaluate((el) => getComputedStyle(el).backgroundColor);
            expect(bg).not.toMatch(/rgba\(.*, 0(\.\d+)?\)$/);
          }
          await expect(sheet).toHaveScreenshot(`inspector-open-${theme}.png`, {
            animations: 'disabled',
          });
          await sheet.getByRole('button', { name: 'Collapse Inspector' }).click();
          await expect(aside(page)).toHaveAttribute('data-collapsed', '');
          await expect(aside(page)).toHaveScreenshot(`inspector-collapsed-${theme}.png`, {
            animations: 'disabled',
          });
          await aside(page).getByRole('button', { name: 'Expand Inspector' }).click();
        }
      },
    );
  });
});
