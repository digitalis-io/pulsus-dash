/**
 * `golden:interim-gallery` (plan #58 §5, T05 §0): the eleven interim Canvas 2D gallery charts in both
 * themes, compared with committed baselines. Chromium only; baselines come from CI (`golden-update`).
 */
import { expect, test, type Page } from '@playwright/test';
import { frame, GALLERY_IDS, GALLERY_URL, galleryReady, open, waitReady } from './helpers.ts';

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
