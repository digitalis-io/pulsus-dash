/**
 * `bench:editor-keystroke` (PRF-005, T09-003; plan #63 Part C Appendix C.6 and C.11.2, D-BENCH;
 * Chromium only, stub BFF): 100 keys typed at the end of a 1 KB PromQL query on Explore › Metrics,
 * and 100 keys typed inside the last line filter of a 1 KB LogQL query on the dev-only LogQL editor
 * harness (`/t/demo/dev/logql-editor`, plan #66 Part A A.8.1). Both cases share one body.
 *
 * - **Editor update (T09-003).** The editor's probe (`src/editor/probe.ts`, installed here before
 *   the page loads) times each CodeMirror update in the page; a key's work is the sum of its
 *   doc-changing updates minus the median of 30 samples without a key. p95 ≤ 2 ms.
 * - **Long tasks (PRF-005).** A Chromium trace of the 100 measured keys, read by
 *   `scripts/longTasks.ts` (the `bench:rooms-long-tasks` parser). T05 §4.3's interim CI check
 *   (`ciOver`: over 50 ms wall and over 16 ms thread time, or no thread time) always blocks; the
 *   16 ms wall limit (`over16`) is the reference lab's.
 *
 * `EDITOR_BENCH_GATE=enforce` (the reference lab, #68, and the local D13 proofs) fails on the p95
 * and `over16` checks; otherwise each breach is a `warning` annotation.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { longTasks, type TraceEvent } from '../scripts/longTasks.ts';
import { waitReady } from './helpers.ts';

const enforce = process.env['EDITOR_BENCH_GATE'] === 'enforce';
const P95_MS = 2.0;
const WARMUP = 20;
const MEASURED = 100;
const IDLE = 30;
const CATEGORIES = [
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'blink.user_timing',
];

/** 19 terms of 51 characters joined by ` + `, then a newline: 1 024 bytes. */
const Q1K = `${Array.from(
  { length: 19 },
  (_, i) => `rate(http_requests_total{job="api",shard="${String(i).padStart(2, '0')}"}[5m])`,
).join(' + ')}\n`;

/**
 * `{app="checkout",env="prod"} | json` (34), 20 label filters of 35, ` |= "` (5), 284 `x` and the
 * closing quote: 1 024 bytes on one line.
 */
const Q1K_LOGQL = `{app="checkout",env="prod"} | json${Array.from({ length: 20 }, (_, i) => {
  const ii = String(i).padStart(2, '0');
  return ` | level="error-${ii}" or status="5${ii}"`;
}).join('')} |= "${'x'.repeat(284)}"`;

interface KeystrokeCase {
  /** The test title and the annotation type. */
  readonly name: string;
  readonly url: string;
  /** The textbox's accessible name. */
  readonly label: string;
  /** Asserted 1 024 UTF-8 bytes. */
  readonly doc: string;
  /** Cycled; ' ' is pressed as Space. */
  readonly keys: string;
  /** Under test-results/. */
  readonly report: string;
  /** Line breaks of `doc` that are not in the content's `textContent`. */
  readonly lineBreaks: number;
  /** After `waitReady(page, url)`. */
  ready(page: Page): Promise<void>;
  /** After the click into the textbox. */
  caret(page: Page): Promise<void>;
}

const PROMQL: KeystrokeCase = {
  name: 'bench:editor-keystroke',
  url: `/t/demo/explore/metrics?from=now-1h&to=now&refresh=off&q=${encodeURIComponent(Q1K)}`,
  label: 'PromQL query',
  doc: Q1K,
  keys: ' or up',
  report: 'bench-editor-keystroke.json',
  // The query's trailing newline.
  lineBreaks: 1,
  ready: async (page) => {
    await expect(page.getByRole('textbox', { name: 'PromQL query' })).toBeVisible();
    await expect(page.locator('[data-chart-frame][data-frame-ready="true"]')).toBeVisible();
  },
  caret: async (page) => {
    await page.keyboard.press('ControlOrMeta+End');
  },
};

const LOGQL: KeystrokeCase = {
  name: 'bench:editor-keystroke logql',
  url: `/t/demo/dev/logql-editor?q=${encodeURIComponent(Q1K_LOGQL)}`,
  label: 'LogQL query',
  doc: Q1K_LOGQL,
  keys: 'error ',
  report: 'bench-editor-keystroke-logql.json',
  lineBreaks: 0,
  ready: async (page) => {
    await expect(page.getByRole('textbox', { name: 'LogQL query' })).toBeVisible();
  },
  // Before the final `"`: inside the line filter, a `none` context (both slots return null).
  caret: async (page) => {
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.press('ArrowLeft');
  },
};

declare global {
  interface Window {
    __editorUpdates: [number, boolean][];
    __pulsusEditorProbe: (ms: number, docChanged: boolean) => void;
  }
}

function percentile(sorted: readonly number[], p: number): number {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i] ?? 0;
}

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

async function keystrokeBench(page: Page, info: TestInfo, c: KeystrokeCase): Promise<void> {
  test.setTimeout(120_000);
  expect(new TextEncoder().encode(c.doc).length).toBe(1024);
  await page.addInitScript(() => {
    window.__editorUpdates = [];
    window.__pulsusEditorProbe = (ms, docChanged) => {
      window.__editorUpdates.push([ms, docChanged]);
    };
  });
  // No fake clock (helpers' `open` installs one): it would also replace `performance.now`.
  await page.goto(c.url);
  await waitReady(page, c.url);
  const editor = page.getByRole('textbox', { name: c.label });
  await c.ready(page);
  await editor.click();
  await c.caret(page);

  /** The editor's doc-changing update time and count for one key (or none). */
  const sample = async (
    press?: () => Promise<void>,
  ): Promise<{ ms: number; docUpdates: number }> => {
    const n0 = await page.evaluate(() => window.__editorUpdates.length);
    await press?.();
    await frames(page);
    const entries = await page.evaluate((n) => window.__editorUpdates.slice(n), n0);
    const changed = entries.filter(([, d]) => d);
    return { ms: changed.reduce((a, [ms]) => a + ms, 0), docUpdates: changed.length };
  };
  const idle: number[] = [];
  for (let i = 0; i < IDLE; i++) idle.push((await sample()).ms);
  const overheadMs = percentile(
    [...idle].sort((a, b) => a - b),
    50,
  );

  const keyAt = (i: number) => c.keys[i % c.keys.length] ?? ' ';
  const press = (k: string) => () => page.keyboard.press(k === ' ' ? 'Space' : k);
  for (let i = 0; i < WARMUP; i++) await sample(press(keyAt(i)));

  const browser = page.context().browser();
  if (browser === null) throw new Error('no browser to trace');
  await browser.startTracing(page, { categories: CATEGORIES });
  const samples: number[] = [];
  const noUpdate: number[] = [];
  for (let i = 0; i < MEASURED; i++) {
    const s = await sample(press(keyAt(WARMUP + i)));
    if (s.docUpdates < 1) noUpdate.push(i);
    samples.push(s.ms - overheadMs);
  }
  const trace = JSON.parse(String(await browser.stopTracing())) as { traceEvents: TraceEvent[] };
  const r = longTasks(trace.traceEvents);

  const sorted = [...samples].sort((a, b) => a - b);
  const report = {
    samples: samples.length,
    overheadMs,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted.at(-1) ?? 0,
    longestTaskMs: r.over16 > 0 ? r.worstMs : 0,
    longTasks: r.over16,
    ciOver: r.ciOver,
    windowMs: r.windowMs,
    mode: enforce ? 'enforce' : 'ci',
  };
  mkdirSync('test-results', { recursive: true });
  writeFileSync(`test-results/${c.report}`, `${JSON.stringify(report, null, 2)}\n`);
  info.annotations.push({
    type: c.name,
    description: `editor update p50 ${report.p50.toFixed(2)} ms, p95 ${report.p95.toFixed(2)} ms, max ${report.max.toFixed(2)} ms; ${String(r.over16)} tasks over 16 ms (worst ${r.worstMs.toFixed(1)} ms), ${String(r.ciOver)} over the CI check`,
  });

  expect(samples).toHaveLength(MEASURED);
  expect(noUpdate.map((i) => `key ${String(i)}: no editor update`)).toEqual([]);
  expect(r.keydowns).toBeGreaterThanOrEqual(MEASURED);
  const text = await editor.evaluate((e) => e.textContent);
  // Line breaks are not in the content's text.
  expect(text.length + c.lineBreaks).toBe(c.doc.length + WARMUP + MEASURED);
  const describe = (tasks: typeof r.tasks): string =>
    tasks
      .map(
        (x) =>
          `${x.durMs.toFixed(1)} ms wall, ${x.threadMs === null ? 'no' : x.threadMs.toFixed(1)} ms thread`,
      )
      .join('; ');
  const ci = r.tasks.filter((x) => x.durMs > 50 && (x.threadMs === null || x.threadMs > 16));
  expect(r.ciOver, describe(ci)).toBe(0);

  const breaches = [
    ...(report.p95 > P95_MS
      ? [`editor update p95 ${report.p95.toFixed(2)} ms > ${String(P95_MS)} ms (T09-003)`]
      : []),
    ...(r.over16 > 0
      ? [`${String(r.over16)} main-thread tasks over 16 ms: ${describe(r.tasks)} (PRF-005)`]
      : []),
  ];
  if (enforce) expect(breaches).toEqual([]);
  else for (const b of breaches) info.annotations.push({ type: 'warning', description: b });
}

test('bench:editor-keystroke', async ({ page }, info) => {
  await keystrokeBench(page, info, PROMQL);
});

test('bench:editor-keystroke logql', async ({ page }, info) => {
  await keystrokeBench(page, info, LOGQL);
});
