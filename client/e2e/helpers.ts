import AxeBuilder from '@axe-core/playwright';
import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { brushSnapUnit } from '../src/engine/canvas2d/columns.ts';
import { AXIS_FONT, STAT_FONT } from '../src/engine/canvas2d/layout.ts';
import { scanLabelInName } from '../src/test/labelInName.ts';

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
/** Explore › Logs with a result on the stub: 30 entries, three volume levels (plan #66 Part C). */
export const LOGS_RESULT =
  '/t/demo/explore/logs?from=now-1h&to=now&refresh=off&q=%7Bservice_name%3D%22stub%22%7D';

/** Nanoseconds as a decimal string (the fake records log windows in ns). */
export function ns(ms: number): string {
  return String(BigInt(ms) * 1000000n);
}

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
  await page.getByRole('button', { name: 'AA, user menu: Ada Admin', exact: true }).click();
  const menu = page.getByRole('menu', { name: 'AA, user menu: Ada Admin', exact: true });
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
  'barchart',
  'barchart-thresholds',
  'barchart-dupes',
  'barchart-subset',
  'barchart-cap',
] as const;

/** The bar chart entries (#173 Part 2), also shot in greyscale (VIZ-067). */
export const BARCHART_IDS = [
  'barchart',
  'barchart-thresholds',
  'barchart-dupes',
  'barchart-subset',
  'barchart-cap',
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

const MIN = 60_000;

/**
 * The page x of the `fromMs` + 20 min and + 25 min targets of frame `f` over the window
 * `fromMs`…`toMs`, 0.1–0.4 brush units inside them, and the plot's y (#58; plan #66 Part C).
 */
export async function brushTargets(_page: Page, f: Locator, fromMs: number, toMs: number) {
  const plot = await plotOf(f);
  const box = await f.boundingBox();
  if (box === null) throw new Error('the frame has no box');
  const t = (x: number): number => timeAt(box.x, plot, x, fromMs, toMs);
  const u = brushSnapUnit((toMs - fromMs) / plot.width);
  const lo = fromMs + 20 * MIN;
  const hi = fromMs + 25 * MIN;
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

/** A Text panel of the boards API (the widgets spec version; plan #198 Part 3b). */
export interface TextPanelInput {
  id: string;
  title: string;
  content: string;
  grid?: [number, number, number, number];
  /** Code mode with this language; absent = Markdown. */
  language?: string;
}

export const textPanelSpec = (p: TextPanelInput) => ({
  id: p.id,
  title: p.title,
  grid: { x: p.grid?.[0] ?? 0, y: p.grid?.[1] ?? 0, w: p.grid?.[2] ?? 12, h: p.grid?.[3] ?? 8 },
  vis: {
    kind: 'text',
    options:
      p.language === undefined
        ? { mode: 'markdown', content: p.content }
        : { mode: 'code', language: p.language, content: p.content },
  },
});

/** POSTs a board of Text panels; the uid, or the failure (status and body) as text. */
export async function postTextBoard(
  request: APIRequestContext,
  title: string,
  panels: readonly TextPanelInput[],
): Promise<{ uid: string } | { error: string }> {
  try {
    const r = await request.post('/api/dash/v1/boards', {
      data: { spec: { title, panels: panels.map(textPanelSpec), sections: [] } },
    });
    if (r.status() !== 201) return { error: `POST board ${String(r.status())}: ${await r.text()}` };
    return { uid: ((await r.json()) as { uid: string }).uid };
  } catch (e) {
    return { error: `POST board: ${String(e)}` };
  }
}

/** POSTs a board of Text panels (expects 201) and returns its uid. */
export async function createTextBoard(
  request: APIRequestContext,
  title: string,
  panels: readonly TextPanelInput[],
): Promise<string> {
  const r = await postTextBoard(request, title, panels);
  if ('error' in r) throw new Error(r.error);
  return r.uid;
}

/** A fixed board window (the fake's `W0`) with refresh off, so a board's requests keep one key. */
export const BOARD_TIME =
  'from=2026-01-01T00%3A00%3A00.000Z&to=2026-01-01T01%3A00%3A00.000Z&refresh=off';

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/** axe's serious and critical violations, as `e2e:a11y-rooms` scans (plus its label-in-name scan). */
export async function axeSerious(page: Page): Promise<string[]> {
  const r = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  const out = r.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  out.push(...(await page.evaluate(scanLabelInName, undefined)));
  return out;
}
