/**
 * The Inspector's e2e fixtures and helpers (plan #192 §5.1), shared by `inspector.spec.ts` and the
 * Chromium-only `golden-inspector.spec.ts`: the boards on the windows of the `inspector-*`
 * transcripts (2026-11-19 UTC) and the gestures that open the Inspector.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import { createBoard, deleteBoard, type PanelInput } from './boardApi.ts';

export const K_FROM = Date.UTC(2026, 10, 19, 12, 44);
export const K_TO = Date.UTC(2026, 10, 19, 13, 44);
export const S_FROM = Date.UTC(2026, 10, 19, 12, 0);
/** 3 h: a board panel of ~570 px plans 30 s steps on it, so H's buckets are 30 s. */
export const S_TO = Date.UTC(2026, 10, 19, 15, 0);
/** Fixture P's instant: 13:41:20. */
export const P_T = Date.UTC(2026, 10, 19, 13, 41, 20);
export const P99 = 'histogram_quantile(0.99, x)';
export const HIST = 'sum by (le) (rate(inspector_bucket[5m]))';

export const iso = (ms: number): string => new Date(ms).toISOString();
export const e = encodeURIComponent;

export function boardUrl(uid: string, from: number, to: number, extra = ''): string {
  return `/t/demo/board/${uid}?from=${e(iso(from))}&to=${e(iso(to))}&refresh=off${extra}`;
}

export const KINDS: PanelInput[] = [
  { id: 'p1', title: 'p99 latency', text: P99, grid: [0, 0, 6, 8], vis: { kind: 'line' } },
  { id: 'p2', title: 'p99 bars', text: P99, grid: [6, 0, 6, 8], vis: { kind: 'bars' } },
  { id: 'p3', title: 'latency buckets', text: HIST, grid: [0, 8, 6, 8], vis: { kind: 'heatmap' } },
  { id: 'p4', title: 'p99 now', text: P99, grid: [6, 8, 6, 8], vis: { kind: 'stat' } },
  {
    id: 'p5',
    title: 'checkout logs',
    text: '{service_name="checkout"}',
    lang: 'logql',
    grid: [0, 16, 12, 8],
    vis: { kind: 'logs' },
  },
];

export const SELECTION: PanelInput[] = [
  { id: 'a', title: 'A', text: 'inspector_two', grid: [0, 0, 6, 8], vis: { kind: 'line' } },
  { id: 'b', title: 'B', text: 'inspector_two', grid: [6, 0, 6, 8], vis: { kind: 'line' } },
];

export const LOGS_BOARD: PanelInput[] = [
  {
    id: 'l1',
    title: 'L1',
    text: '{app="inspector"}',
    lang: 'logql',
    grid: [0, 0, 6, 8],
    vis: { kind: 'logs' },
  },
  {
    id: 'l2',
    title: 'L2',
    text: '{app="inspector"}',
    lang: 'logql',
    grid: [6, 0, 6, 8],
    vis: { kind: 'logs' },
  },
  { id: 'b', title: 'B', text: 'inspector_two', grid: [0, 8, 6, 8], vis: { kind: 'line' } },
  { id: 'h', title: 'H', text: HIST, grid: [6, 8, 6, 8], vis: { kind: 'heatmap' } },
];

export const panel = (page: Page, id: string): Locator => page.locator(`[data-panel-id="${id}"]`);
export const aside = (page: Page): Locator => page.locator('[data-inspector]:not([data-closing])');
/** The incoming layer: during a crossfade the outgoing one is still in the DOM for 150 ms. */
export const current = (page: Page): Locator =>
  aside(page).locator('[data-inspector-content]:not([data-leaving])');
export const heading = (page: Page): Locator => aside(page).getByRole('heading', { level: 2 });

/** The page point of `tMs` at the fraction `fy` of the plot's height, in panel `id`'s chart. */
export async function plotPoint(
  page: Page,
  id: string,
  tMs: number,
  fy: number,
  from: number,
  to: number,
): Promise<{ x: number; y: number }> {
  const frame = panel(page, id).locator('[data-chart-frame][data-frame-ready="true"]');
  await frame.scrollIntoViewIfNeeded();
  const box = await frame.boundingBox();
  const plot = (await frame.getAttribute('data-plot'))?.split(',').map(Number) ?? [];
  const [px = 0, py = 0, pw = 0, ph = 0] = plot;
  if (box === null) throw new Error(`no chart box in ${id}`);
  return { x: box.x + px + ((tMs - from) / (to - from)) * pw, y: box.y + py + fy * ph };
}

export async function clickAt(page: Page, p: { x: number; y: number }): Promise<void> {
  await page.mouse.click(p.x, p.y);
}

/** Opens fixture P: a click on p1 at 13:41:20 near the top, nearest the checkout series. */
export async function inspectP(page: Page): Promise<void> {
  await clickAt(page, await plotPoint(page, 'p1', P_T, 0.12, K_FROM, K_TO));
  await expect(heading(page)).toHaveText('p99 latency');
}

export async function withBoard(
  page: Page,
  request: Parameters<typeof createBoard>[0],
  name: string,
  panels: PanelInput[],
  url: (uid: string) => string,
  body: () => Promise<void>,
): Promise<void> {
  const uid = await createBoard(request, `${name} ${crypto.randomUUID()}`, panels);
  try {
    await page.goto(url(uid));
    await page.locator('html[data-shell-ready="true"]').waitFor();
    await body();
  } finally {
    await deleteBoard(request, uid);
  }
}
