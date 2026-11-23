/**
 * `e2e:chart-brush` (plan #58 §5, IA-020 subset; #93, INT-025): right drag (or `Alt`+left drag) to
 * brush a window, double-click to zoom out.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  brushTargets,
  frame,
  GALLERY_FROM,
  GALLERY_TO,
  GALLERY_URL,
  galleryReady,
  open,
  searchOf,
  timeTrigger,
} from './helpers.ts';

/** The 12:20 and 12:25 targets of the gallery's `line-1`. */
function targets(page: Page) {
  return brushTargets(page, frame(page, 'line-1'), GALLERY_FROM, GALLERY_TO);
}

test('e2e:chart-brush', async ({ page }) => {
  await open(page, GALLERY_URL);
  await galleryReady(page);
  const { x1, x2, y, box, plot } = await targets(page);
  await page.mouse.move(x1, y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(x2, y, { steps: 10 });
  await page.mouse.up({ button: 'right' });
  await expect
    .poll(() => searchOf(page))
    .toMatchObject({ from: '2026-11-19T12:20:00.000Z', to: '2026-11-19T12:25:00.000Z' });
  // The URL changes before the page re-renders; the double-click must see the new window.
  await expect(timeTrigger(page)).toHaveText('19 Nov 2026, 12:20:00 – 12:25:00');
  await page.mouse.dblclick(box.x + plot.x + plot.width / 2, y);
  await expect
    .poll(() => searchOf(page))
    .toMatchObject({ from: '2026-11-19T12:17:30.000Z', to: '2026-11-19T12:27:30.000Z' });
  await expect(timeTrigger(page)).toHaveText('19 Nov 2026, 12:17:30 – 12:27:30');

  // Alt+left drag brushes the same window.
  await open(page, GALLERY_URL);
  await galleryReady(page);
  const t2 = await targets(page);
  await page.mouse.move(t2.x1, t2.y);
  await page.keyboard.down('Alt');
  await page.mouse.down();
  await page.mouse.move(t2.x2, t2.y, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await expect
    .poll(() => searchOf(page))
    .toMatchObject({ from: '2026-11-19T12:20:00.000Z', to: '2026-11-19T12:25:00.000Z' });
});
