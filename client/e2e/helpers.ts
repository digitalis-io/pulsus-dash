import { expect, type Locator, type Page } from '@playwright/test';
import { AXIS_FONT, STAT_FONT } from '../src/engine/canvas2d/layout.ts';

/** 2026-11-19 13:03 London (GMT), the fixed "now" of the suite. */
export const T = Date.UTC(2026, 10, 19, 13, 3);
export const ORIGIN = 'http://localhost:4173';

export const enc = (iso: string): string => encodeURIComponent(iso);

/** Every page, by URL (the shell pages carry the default Context). */
export const SHELL_PAGES = [
  '/t/demo/boards',
  '/t/demo/board/b-1',
  '/t/demo/explore/metrics',
  '/t/demo/explore/logs',
  '/t/demo/admin',
  '/t/demo/dev/gallery',
] as const;
/** Explore with a result on the stub (rate applied, three `stub_metric` series; plan #63 C.7). */
export const EXPLORE_RESULT =
  '/t/demo/explore/metrics?from=now-1h&to=now&refresh=off&q=http_requests_total';

export const STANDALONE_PAGES = ['/nope', '/signed-out'] as const;
export const ALL_PAGES = [...SHELL_PAGES, ...STANDALONE_PAGES] as const;

/** Freezes `Date.now()` at `time` (timers keep running), then opens `url`. */
export async function open(page: Page, url: string, time: number = T): Promise<void> {
  await page.clock.setFixedTime(time);
  await page.goto(url);
  await waitReady(page, url);
}

export async function waitReady(page: Page, url: string): Promise<void> {
  if (url.startsWith('/t/')) {
    await page.locator('html[data-shell-ready="true"]').waitFor();
    await expect(page.getByRole('heading', { level: 1 })).not.toHaveText('');
  } else {
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  }
}

export function searchOf(page: Page): Record<string, string> {
  return Object.fromEntries(new URL(page.url()).searchParams);
}

export function timeTrigger(page: Page) {
  return page.getByRole('banner').getByRole('button', { name: /^(Last|\d|now)/ });
}

export async function openPicker(page: Page) {
  await timeTrigger(page).click();
  const dialog = page.getByRole('dialog', { name: 'Time range' });
  await dialog.getByRole('listbox', { name: 'Quick ranges' }).waitFor();
  return dialog;
}

export async function openUserMenu(page: Page) {
  await page.getByRole('button', { name: 'User menu: Ada Admin' }).click();
  const menu = page.getByRole('menu', { name: 'User menu: Ada Admin' });
  await menu.waitFor();
  return menu;
}

/** The chart gallery (dev and stub builds), 12:00–13:00 UTC on 19 Nov 2026 (#58). */
export const GALLERY = '/t/demo/dev/gallery';
export const GALLERY_FROM = Date.UTC(2026, 10, 19, 12);
export const GALLERY_TO = Date.UTC(2026, 10, 19, 13);
export const GALLERY_URL = `${GALLERY}?from=${enc('2026-11-19T12:00:00.000Z')}&to=${enc('2026-11-19T13:00:00.000Z')}&refresh=off`;
export const GALLERY_IDS = [
  'line-1',
  'line-50',
  'line-gaps',
  'line-600',
  'heatmap',
  'bars',
  'stat',
  'line-thresholds',
  'stat-sparkline',
  'line-extreme',
  'line-events',
] as const;

/** The chart frame of a gallery entry. */
export function frame(page: Page, id: string): Locator {
  return page.locator(`[data-gallery-id="${id}"] [data-chart-frame]`);
}

export interface Plot {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The frame's plot rectangle (CSS px, relative to the frame), once it has drawn. */
export async function plotOf(f: Locator): Promise<Plot> {
  await expect(f).toHaveAttribute('data-frame-ready', 'true');
  const [x = 0, y = 0, width = 0, height = 0] = ((await f.getAttribute('data-plot')) ?? '')
    .split(',')
    .map(Number);
  return { x, y, width, height };
}

/** The page x of time `ms` in a frame whose box starts at `boxX`. */
export function plotX(boxX: number, plot: Plot, ms: number, fromMs: number, toMs: number): number {
  return boxX + plot.x + ((ms - fromMs) / (toMs - fromMs)) * plot.width;
}

/** The time under page x `x` (the engine's pointer formula). */
export function timeAt(boxX: number, plot: Plot, x: number, fromMs: number, toMs: number): number {
  return fromMs + ((x - boxX - plot.x) / plot.width) * (toMs - fromMs);
}

/** Waits until every gallery chart has drawn with its fonts loaded. */
export async function galleryReady(page: Page): Promise<void> {
  await expect(page.locator('[data-chart-frame][data-frame-ready="true"]')).toHaveCount(
    GALLERY_IDS.length,
  );
  await page.waitForFunction(
    (fonts) => fonts.every((f) => document.fonts.check(f)),
    [AXIS_FONT, STAT_FONT],
  );
  await page.evaluate(
    () =>
      new Promise<void>((r) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            r();
          });
        });
      }),
  );
}
