/**
 * The dev-only log stream harness (`/t/demo/dev/log-stream`, plan #66 Part B, B.2) as the e2e
 * specs drive it: the config set before the page loads, `window.__logStreamBench`, and "at rest"
 * (no `scroll` event on the scroller for 300 ms, B.4).
 */
import { expect, type Page } from '@playwright/test';
import { waitReady } from './helpers.ts';

export const BENCH_URL = '/t/demo/dev/log-stream';

export interface ViewLimits {
  readonly cap: number;
  readonly margin: number;
  readonly maxPx: number;
  readonly hardPx: number;
}

export interface BenchConfig {
  readonly total: number;
  readonly prefillTo: number;
  readonly capEntries: number;
  readonly latencyMs: number;
  readonly view?: ViewLimits;
  readonly wrap?: boolean;
  readonly lineLength?: number;
  readonly wrapEstimate?: 'bound' | 'row';
}

export const MAX_ENTRIES = 1_000_000;

export type Cause = 'edge' | 'extent' | 'hard' | 'wrap' | 'scrollTo';

export interface TopRow {
  readonly ord: number;
  readonly top: number;
}

export interface BenchState {
  readonly firstOrd: number;
  readonly endOrd: number;
  readonly held: number;
  readonly tail: string;
  readonly calls: number;
  readonly writes: number;
  readonly reslices: Readonly<Record<Cause, number>>;
  /** The same counts, for re-slices made while the virtualiser's `isScrolling` was true. */
  readonly reslicesScrolling: Readonly<Record<Cause, number>>;
}

export interface ResliceRecord {
  readonly cause: Cause;
  readonly scrolling: boolean;
  /** `topRow()` when the re-slice was decided, before its commit. */
  readonly before: TopRow | null;
}

declare global {
  interface Window {
    __logStreamBenchConfig?: Partial<BenchConfig>;
    __logStreamBench?: {
      scrollToOrd(ord: number): void;
      loadTail(): Promise<void>;
      state(): BenchState;
      topRow(): TopRow | null;
      reslicesLog(): ResliceRecord[];
      writesAt(): number[];
      showControl(on: boolean): void;
    };
    __lastScrollAt?: number;
  }
}

/** Sets the config, opens the harness and waits for the prefill; then records scroll times. */
/** `config` is merged over the harness's default config (B.2). */
export async function openBench(
  page: Page,
  config: Partial<BenchConfig>,
  timeout = 90_000,
): Promise<void> {
  await page.addInitScript((c) => {
    window.__logStreamBenchConfig = c;
  }, config);
  await page.goto(BENCH_URL);
  await waitReady(page, BENCH_URL);
  await page.locator('[data-prefilled="true"]').waitFor({ timeout });
  await page.evaluate(() => {
    window.__lastScrollAt = performance.now();
    document.querySelector('[data-log-scroller]')?.addEventListener(
      'scroll',
      () => {
        window.__lastScrollAt = performance.now();
      },
      { passive: true, capture: true },
    );
  });
}

/** Waits until no `scroll` event for 300 ms. */
export async function atRest(page: Page): Promise<void> {
  await page.waitForFunction(
    () => performance.now() - (window.__lastScrollAt ?? 0) >= 300,
    undefined,
    { polling: 50, timeout: 30_000 },
  );
}

export const state = (page: Page): Promise<BenchState> =>
  page.evaluate(() => {
    const b = window.__logStreamBench;
    if (b === undefined) throw new Error('no harness');
    return b.state();
  });

export const topRow = (page: Page): Promise<TopRow | null> =>
  page.evaluate(() => window.__logStreamBench?.topRow() ?? null);

export const reslicesLog = (page: Page): Promise<ResliceRecord[]> =>
  page.evaluate(() => window.__logStreamBench?.reslicesLog() ?? []);

export const sliceStart = (page: Page): Promise<string | null> =>
  page.locator('[data-slice-start]').getAttribute('data-slice-start');

export async function scrollToOrd(page: Page, ord: number): Promise<void> {
  await page.evaluate((o) => {
    window.__logStreamBench?.scrollToOrd(o);
  }, ord);
}

/** The centre of the scroller (or of `selector`), for wheel and gesture input. */
export async function centre(
  page: Page,
  selector = '[data-log-scroller]',
): Promise<{ x: number; y: number }> {
  const box = await page.locator(selector).boundingBox();
  if (box === null) throw new Error('no scroller box');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

export async function wheel(page: Page, dy: number): Promise<void> {
  const c = await centre(page);
  await page.mouse.move(c.x, c.y);
  await page.mouse.wheel(0, dy);
}

export function expectSameTop(a: TopRow | null, b: TopRow | null, what: string): void {
  expect(a, `${what}: top row before`).not.toBeNull();
  expect(b, `${what}: top row after`).not.toBeNull();
  expect(b?.ord, `${what}: ordinal`).toBe(a?.ord);
  expect(Math.abs((b?.top ?? 0) - (a?.top ?? 0)), `${what}: offset`).toBeLessThanOrEqual(1);
}

/** The list's height and every mounted row's height and `.line` box. */
export const rowBoxes = (page: Page) =>
  page.evaluate(() => {
    const list = document.querySelector<HTMLElement>('[data-slice-start]');
    const rows = [...document.querySelectorAll<HTMLElement>('[data-log-row]')].map((r) => {
      const line = r.querySelector<HTMLElement>('[data-log-line]');
      const lh = line === null ? 0 : parseFloat(getComputedStyle(line).lineHeight);
      return {
        ord: Number(r.dataset['ord']),
        height: r.getBoundingClientRect().height,
        scrollHeight: line?.scrollHeight ?? 0,
        clientHeight: line?.clientHeight ?? 0,
        lines: line === null || lh === 0 ? 0 : line.scrollHeight / lh,
        text: line?.textContent.length ?? 0,
      };
    });
    return { listHeight: list?.getBoundingClientRect().height ?? 0, rows };
  });
