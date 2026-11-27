/**
 * `golden:widget-gallery` (plan #198 Part 3b §5, plan #216 Part 2a §4.6; VIZ-069, VIZ-067, T24-015,
 * T24-027): the widget gallery's Text pages (`widget-text`, `widget-text-removals`) and Board list
 * pages (`widget-board-list`, `-search`, `-states`, in UTC at a fixed clock) in the dark and light themes and
 * in greyscale (CSSOM `grayscale(1)` on dark), compared with committed baselines. A reload draws
 * the same pixels. Chromium only; the baselines are generated in the pinned e2e container
 * (`PW_UPDATE_GOLDENS=1`).
 */
import { expect, test, type Page } from '@playwright/test';
import { waitReady } from './helpers.ts';

const TEXT_PAGES = ['widget-text', 'widget-text-removals'] as const;
const LIST_PAGES = [
  'widget-board-list',
  'widget-board-list-search',
  'widget-board-list-states',
] as const;
const PAGES = [...TEXT_PAGES, ...LIST_PAGES] as const;
/** The Board list pages' clock: the states page's failed refresh is at this time. */
const LIST_NOW = new Date('2026-11-26T12:31:05Z');
const THEMES = ['dark', 'light', 'greyscale'] as const;

// Tall enough that each page fits below the app header without scrolling.
test.use({ viewport: { width: 1440, height: 1400 }, timezoneId: 'UTC' });

const url = (p: string): string => `/t/demo/dev/widgets?page=${p}&refresh=off`;

/**
 * Text pages: every body shows content. Board list pages: the Loading panel (which never settles)
 * shows its delayed text, and every other list is settled (ok or empty, not fetching). Then both
 * faces are loaded.
 */
async function ready(page: Page, p: string): Promise<void> {
  await waitReady(page, url(p));
  if ((LIST_PAGES as readonly string[]).includes(p)) {
    const lists = page.locator('[data-widget-gallery] [data-board-list]');
    await expect(lists.first()).toBeVisible();
    const loading = page.locator('[data-gallery-id="bl-loading"] [data-board-list]');
    if ((await loading.count()) > 0) await expect(loading.getByText('Loading…')).toBeVisible();
    const others = page.locator(
      '[data-widget-gallery] [data-gallery-id]:not([data-gallery-id="bl-loading"]) [data-board-list]',
    );
    await expect(
      others.and(
        page.locator(':not([data-board-list-phase="ok"]):not([data-board-list-phase="empty"])'),
      ),
    ).toHaveCount(0);
    await expect(others.and(page.locator('[data-board-list-fetching]'))).toHaveCount(0);
  } else {
    const bodies = page.locator('[data-widget-gallery] [data-text-body]');
    await expect(bodies.first()).toBeVisible();
    await expect(page.locator('[data-widget-gallery] [data-text-state="loading"]')).toHaveCount(0);
  }
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
      if ((LIST_PAGES as readonly string[]).includes(p)) await page.clock.setFixedTime(LIST_NOW);
      await page.goto(url(p));
      await ready(page, p);
      await shoot(page, p, theme);
      await page.reload();
      await ready(page, p);
      await shoot(page, p, theme);
    });
  }
}
