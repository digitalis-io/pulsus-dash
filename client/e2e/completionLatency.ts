/**
 * The completion latency helpers of `bench:logql-completion-latency` (#66) and
 * `bench:promql-completion-latency` (#107): percentiles, two animation frames, the keydown to
 * popup probe and one trial. A sample is the keydown's `timeStamp` to the completion popup's
 * insertion in the editor's shadow root (a `MutationObserver`); each sample also records that
 * span (`__spans`), so a bench can sum the work reported inside it.
 */
import { expect, type Page } from '@playwright/test';
import { waitReady } from './helpers.ts';

export const TRIALS = 30;
export const DEBOUNCE_MS = 120;
export const LOCAL_P95_MS = 16;
export const REMOTE_P95_MS = 136;

declare global {
  interface Window {
    __down: number | null;
    __lat: number[];
    /** `[keydown timeStamp, popup time]` of each sample, in `performance.now()` time. */
    __spans: [number, number][];
  }
}

export function percentile(sorted: readonly number[], p: number): number {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i] ?? 0;
}

export const summary = (xs: readonly number[]): { p50: number; p95: number; max: number } => {
  const s = [...xs].sort((a, b) => a - b);
  return { p50: percentile(s, 50), p95: percentile(s, 95), max: s.at(-1) ?? 0 };
};

export async function frames(page: Page): Promise<void> {
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

/**
 * Opens `url`, waits for the textbox named `label`, installs the keydown and popup probe, clicks
 * into the editor, moves the caret to the end and then `arrowLefts` characters left.
 */
export async function openProbed(
  page: Page,
  url: string,
  label: string,
  arrowLefts: number,
): Promise<void> {
  await page.goto(url);
  await waitReady(page, url);
  const editor = page.getByRole('textbox', { name: label });
  await expect(editor).toBeVisible();
  await page.evaluate(() => {
    window.__down = null;
    window.__lat = [];
    window.__spans = [];
    document.addEventListener(
      'keydown',
      (e) => {
        window.__down = e.timeStamp;
      },
      { capture: true },
    );
    const host = [...document.querySelectorAll('[data-editor-host] > *')].find(
      (e) => e.shadowRoot !== null,
    );
    const root = host?.shadowRoot;
    if (root === null || root === undefined) throw new Error('no editor shadow root');
    new MutationObserver(() => {
      if (window.__down !== null && root.querySelector('.cm-tooltip-autocomplete') !== null) {
        const t = performance.now();
        window.__lat.push(t - window.__down);
        window.__spans.push([window.__down, t]);
        window.__down = null;
      }
    }).observe(root, { childList: true, subtree: true });
  });
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  for (let i = 0; i < arrowLefts; i++) await page.keyboard.press('ArrowLeft');
}

/** Types `key`, waits for the popup's sample, then closes it and deletes the key. */
export async function trial(page: Page, key: string): Promise<void> {
  const n = await page.evaluate(() => window.__lat.length);
  await page.keyboard.type(key);
  await page.waitForFunction((k) => window.__lat.length > k, n, { timeout: 2000 });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Backspace');
}
