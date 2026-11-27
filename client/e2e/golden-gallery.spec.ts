/**
 * `golden:interim-gallery` (plan #58 §5, T05 §0): the eighteen interim Canvas 2D gallery charts in
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
  // Through CSSOM: the page's CSP (style-src 'self') blocks an injected style tag.
  await page.evaluate(() => {
    for (const c of document.querySelectorAll('canvas')) c.style.filter = 'grayscale(1)';
  });
  for (const id of BARCHART_IDS) {
    await expect.soft(frame(page, id)).toHaveScreenshot(`gallery-${id}-greyscale.png`);
  }
});

/**
 * `golden:gallery` (amended, plan #234 Part 3 §5; VIZ-069, VIZ-067): the geomap gallery pages
 * `geomap-markers` (G), `geomap-groups` (H) and `geomap-states` (G with thresholds, colour by group
 * and by state), each frame in dark, light and greyscale (dark with the canvas in greyscale).
 */
const GEO_PAGES: Readonly<Record<string, readonly string[]>> = {
  'geomap-markers': ['geomap-markers'],
  'geomap-groups': ['geomap-groups'],
  'geomap-states': ['geomap-states-group', 'geomap-states-state'],
};

for (const [page, ids] of Object.entries(GEO_PAGES)) {
  for (const theme of ['dark', 'light', 'greyscale'] as const) {
    test(`golden:gallery ${page} ${theme}`, async ({ page: p }) => {
      await p.addInitScript((t) => {
        localStorage.setItem('pulsus-dash.theme', t === 'light' ? 'light' : 'dark');
      }, theme);
      await open(p, `/t/demo/dev/geo?page=${page}`);
      const frames = p.locator('[data-geo-gallery] [data-chart-frame][data-frame-ready="true"]');
      await expect(frames).toHaveCount(ids.length);
      if (theme === 'greyscale') {
        await p.evaluate(() => {
          for (const c of document.querySelectorAll('canvas')) c.style.filter = 'grayscale(1)';
        });
      }
      for (const id of ids) {
        await expect
          .soft(p.locator(`[data-geo-gallery="${id}"] [data-chart-frame]`))
          .toHaveScreenshot(`${id}-${theme}.png`);
      }
    });
  }
}

/**
 * The whole map host of `geomap-groups` (H) per theme (review r1): the surface, the legend and the
 * coverage meter, so their look is covered as well as the canvas.
 */
for (const theme of ['dark', 'light', 'greyscale'] as const) {
  test(`golden:gallery geomap-groups-panel ${theme}`, async ({ page: p }) => {
    await p.addInitScript((t) => {
      localStorage.setItem('pulsus-dash.theme', t === 'light' ? 'light' : 'dark');
    }, theme);
    await open(p, '/t/demo/dev/geo?page=geomap-groups');
    await expect(
      p.locator('[data-geo-gallery] [data-chart-frame][data-frame-ready="true"]'),
    ).toHaveCount(1);
    await expect(p.locator('[data-geo-legend] button')).toHaveCount(8);
    if (theme === 'greyscale') {
      await p.evaluate(() => {
        for (const c of document.querySelectorAll('canvas')) c.style.filter = 'grayscale(1)';
      });
    }
    await expect
      .soft(p.locator('[data-geo-gallery="geomap-groups"] [data-geomap]'))
      .toHaveScreenshot(`geomap-groups-panel-${theme}.png`);
  });
}
