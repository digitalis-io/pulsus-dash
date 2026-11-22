/**
 * `e2e:chart-brush` (plan #58 §5, IA-020 subset; #93, INT-025): right drag (or `Alt`+left drag) to
 * brush a window, double-click to zoom out.
 */
import { expect, test, type Page } from '@playwright/test';
import { brushSnapUnit } from '../src/engine/canvas2d/columns.ts';
import {
  frame,
  GALLERY_FROM,
  GALLERY_TO,
  GALLERY_URL,
  galleryReady,
  open,
  plotOf,
  searchOf,
  timeAt,
  timeTrigger,
} from './helpers.ts';

const MIN = 60_000;

/** The page x of the 12:20 and 12:25 targets, 0.1–0.4 brush units inside them, and the plot's y. */
async function targets(page: Page) {
  const f = frame(page, 'line-1');
  const plot = await plotOf(f);
  const box = await f.boundingBox();
  if (box === null) throw new Error('line-1 has no box');
  const t = (x: number): number => timeAt(box.x, plot, x, GALLERY_FROM, GALLERY_TO);
  const u = brushSnapUnit((GALLERY_TO - GALLERY_FROM) / plot.width);
  const lo = GALLERY_FROM + 20 * MIN;
  const hi = GALLERY_FROM + 25 * MIN;
  // Integer page pixels 0.1u–0.4u inside the target boundaries: only snapping gives the exact URL.
  let x1 = Math.floor(box.x + plot.x);
  while (t(x1) < lo + 0.1 * u) x1 += 1;
  let x2 = Math.ceil(box.x + plot.x + plot.width);
  while (t(x2) > hi - 0.1 * u) x2 -= 1;
  expect(t(x1)).toBeLessThanOrEqual(lo + 0.4 * u);
  expect(t(x2)).toBeGreaterThanOrEqual(hi - 0.4 * u);
  const y = box.y + plot.y + plot.height / 2;
  return { x1, x2, y, box, plot };
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
