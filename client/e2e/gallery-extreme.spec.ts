/**
 * `e2e:gallery-extreme` (#97 plan §5 D, acceptance 3): the `line-extreme` gallery entry, values over
 * [−MAX, MAX], draws, and the main thread stays responsive afterwards.
 */
import { expect, test } from '@playwright/test';
import { frame, GALLERY_URL, galleryReady, open, plotOf } from './helpers.ts';

test('e2e:gallery-extreme line-extreme draws and the page stays responsive', async ({ page }) => {
  test.setTimeout(60_000);
  await open(page, GALLERY_URL);
  await galleryReady(page);
  const f = frame(page, 'line-extreme');
  await expect(f).toHaveAttribute('data-frame-ready', 'true');
  const plot = await plotOf(f);
  expect(plot.width).toBeGreaterThan(0);
  expect(plot.height).toBeGreaterThan(0);
  const answered = await Promise.race([
    page.evaluate(() => 1),
    new Promise<number>((r) => {
      setTimeout(() => {
        r(0);
      }, 2_000);
    }),
  ]);
  expect(answered, 'the main thread did not answer within 2 s').toBe(1);
});
