/**
 * `golden:interim-gallery` (plan #58 §5, T05 §0): the sixteen interim Canvas 2D gallery charts in
 * both themes, compared with committed baselines, and `golden:greyscale` (VIZ-067, plan #173 Part 2):
 * the five bar charts with the canvas in greyscale, told apart without colour. Chromium only; the
 * baselines are generated in the pinned e2e container (`PW_UPDATE_GOLDENS=1`).
 */
import { expect, test, type Page } from '@playwright/test';
import {
  BARCHART_IDS,
  frame,
  GALLERY_IDS,
  GALLERY_URL,
  galleryReady,
  open,
  waitReady,
} from './helpers.ts';

async function compare(page: Page, theme: string): Promise<void> {
  // Soft: one run reports every frame that differs.
  for (const id of GALLERY_IDS) {
    await expect.soft(frame(page, id)).toHaveScreenshot(`gallery-${id}-${theme}.png`);
  }
}

for (const theme of ['dark', 'light'] as const) {
  test(`golden:interim-gallery ${theme}`, async ({ page }) => {
    await page.addInitScript((t) => {
      localStorage.setItem('pulsus-dash.theme', t);
    }, theme);
    await open(page, GALLERY_URL);
    await galleryReady(page);
    await compare(page, theme);
    // A second seeded run draws the same pixels.
    await page.reload();
    await waitReady(page, GALLERY_URL);
    await galleryReady(page);
    await compare(page, theme);
  });
}

test('golden:greyscale', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('pulsus-dash.theme', 'dark');
  });
  await open(page, GALLERY_URL);
  await galleryReady(page);
  await page.addStyleTag({ content: 'canvas { filter: grayscale(1); }' });
  for (const id of BARCHART_IDS) {
    await expect.soft(frame(page, id)).toHaveScreenshot(`gallery-${id}-greyscale.png`);
  }
});
