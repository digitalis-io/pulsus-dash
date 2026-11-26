/**
 * `golden:widget-gallery`, the Text pages (plan #198 Part 3b §5; VIZ-069, VIZ-067, T24-015): the
 * widget gallery's `widget-text` and `widget-text-removals` pages in the dark and light themes and
 * in greyscale (CSSOM `grayscale(1)` on dark), compared with committed baselines. A reload draws
 * the same pixels. Chromium only; the baselines are generated in the pinned e2e container
 * (`PW_UPDATE_GOLDENS=1`).
 */
import { expect, test, type Page } from '@playwright/test';
import { waitReady } from './helpers.ts';

const PAGES = ['widget-text', 'widget-text-removals'] as const;
const THEMES = ['dark', 'light', 'greyscale'] as const;

// Tall enough that each page fits below the app header without scrolling.
test.use({ viewport: { width: 1440, height: 1400 } });

const url = (p: string): string => `/t/demo/dev/widgets?page=${p}&refresh=off`;

/** Every Text body shows content and both faces are loaded. */
async function ready(page: Page, p: string): Promise<void> {
  await waitReady(page, url(p));
  const bodies = page.locator('[data-widget-gallery] [data-text-body]');
  await expect(bodies.first()).toBeVisible();
  await expect(page.locator('[data-widget-gallery] [data-text-state="loading"]')).toHaveCount(0);
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.waitForFunction(() =>
    ['14px "Inter Variable"', '14px "JetBrains Mono Variable"'].every((f) =>
      document.fonts.check(f),
    ),
  );
}

async function shoot(page: Page, p: string, theme: string): Promise<void> {
  if (theme === 'greyscale') {
    // Through CSSOM: the page's CSP (style-src 'self') blocks an injected style tag.
    await page.locator('[data-widget-gallery]').evaluate((e) => {
      (e as HTMLElement).style.filter = 'grayscale(1)';
    });
  }
  await expect.soft(page.locator('[data-widget-gallery]')).toHaveScreenshot(`${p}-${theme}.png`);
}

for (const p of PAGES) {
  for (const theme of THEMES) {
    test(`golden:widget-gallery ${p} ${theme}`, async ({ page }) => {
      await page.addInitScript(
        (th) => {
          localStorage.setItem('pulsus-dash.theme', th);
        },
        theme === 'light' ? 'light' : 'dark',
      );
      await page.goto(url(p));
      await ready(page, p);
      await shoot(page, p, theme);
      await page.reload();
      await ready(page, p);
      await shoot(page, p, theme);
    });
  }
}
