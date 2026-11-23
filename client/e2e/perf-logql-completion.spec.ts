/**
 * `bench:logql-completion-latency` (T09-007, T09 §7; plan #66 Part A A.8.2; Chromium only, stub
 * build): keydown to completion popup on the dev-only LogQL editor harness, whose in-memory source
 * answers at once, so the client alone is timed.
 *
 * - **Local** (30 trials): `|` after `{app="web"} ` opens the stage list from the synchronous slot.
 * - **Remote** (30 trials): `w` inside `{app=""}` opens the label values after the 120 ms debounce.
 *
 * Always: 30 + 30 samples and remote min ≥ 120 ms (the debounce is never skipped). With
 * `EDITOR_BENCH_GATE=enforce` (the reference lab and the local D13 proofs): local p95 ≤ 16 ms and
 * remote p95 ≤ 136 ms; otherwise each breach is a `warning` annotation.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { waitReady } from './helpers.ts';

const enforce = process.env['EDITOR_BENCH_GATE'] === 'enforce';
const TRIALS = 30;
const DEBOUNCE_MS = 120;
const LOCAL_P95_MS = 16;
const REMOTE_P95_MS = 136;

declare global {
  interface Window {
    __down: number | null;
    __lat: number[];
  }
}

function percentile(sorted: readonly number[], p: number): number {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i] ?? 0;
}

const summary = (xs: readonly number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return { p50: percentile(s, 50), p95: percentile(s, 95), max: s.at(-1) ?? 0 };
};

async function frames(page: Page): Promise<void> {
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

/** Opens the harness on `doc`, installs the probe and puts the caret at the end. */
async function open(page: Page, doc: string): Promise<void> {
  const url = `/t/demo/dev/logql-editor?q=${encodeURIComponent(doc)}`;
  await page.goto(url);
  await waitReady(page, url);
  const editor = page.getByRole('textbox', { name: 'LogQL query' });
  await expect(editor).toBeVisible();
  await page.evaluate(() => {
    window.__down = null;
    window.__lat = [];
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
        window.__lat.push(performance.now() - window.__down);
        window.__down = null;
      }
    }).observe(root, { childList: true, subtree: true });
  });
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
}

/** Types `key`, waits for the popup's sample, then closes it and deletes the key. */
async function trial(page: Page, key: string): Promise<void> {
  const n = await page.evaluate(() => window.__lat.length);
  await page.keyboard.type(key);
  await page.waitForFunction((k) => window.__lat.length > k, n, { timeout: 2000 });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Backspace');
}

test('bench:logql-completion-latency', async ({ page }, info) => {
  test.setTimeout(120_000);

  await open(page, '{app="web"} ');
  for (let i = 0; i < TRIALS; i++) {
    await trial(page, '|');
    await frames(page);
  }
  const local = await page.evaluate(() => [...window.__lat]);

  await open(page, '{app=""}');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  for (let i = 0; i < TRIALS; i++) {
    await trial(page, 'w');
    await page.waitForTimeout(200);
  }
  const remote = await page.evaluate(() => [...window.__lat]);

  const report = { local: summary(local), remote: summary(remote) };
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/bench-logql-completion.json', `${JSON.stringify(report, null, 2)}\n`);
  info.annotations.push({
    type: 'bench:logql-completion-latency',
    description: `local p50 ${report.local.p50.toFixed(1)} ms, p95 ${report.local.p95.toFixed(1)} ms; remote p50 ${report.remote.p50.toFixed(1)} ms, p95 ${report.remote.p95.toFixed(1)} ms, min ${Math.min(...remote).toFixed(1)} ms`,
  });

  expect(local).toHaveLength(TRIALS);
  expect(remote).toHaveLength(TRIALS);
  // The debounce is never skipped, and its timer never fires early.
  expect(Math.min(...remote)).toBeGreaterThanOrEqual(DEBOUNCE_MS);

  const breaches = [
    ...(report.local.p95 > LOCAL_P95_MS
      ? [`local p95 ${report.local.p95.toFixed(1)} ms > ${String(LOCAL_P95_MS)} ms (T09 §7)`]
      : []),
    ...(report.remote.p95 > REMOTE_P95_MS
      ? [`remote p95 ${report.remote.p95.toFixed(1)} ms > ${String(REMOTE_P95_MS)} ms (T09-007)`]
      : []),
  ];
  if (enforce) expect(breaches).toEqual([]);
  else for (const b of breaches) info.annotations.push({ type: 'warning', description: b });
});
