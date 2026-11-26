/**
 * `bench:text-widget-render` (plan #198 Part 3b §4.3; T24 §7, PRF-005): the uncached Markdown
 * render, the commit and the long tasks of Text panels, on Chromium (the reference browser) against
 * the production stub build. Report-only; `LONG_TASK_GATE=enforce` fails a miss.
 *
 * Board P (seeded into the stub through `pulsus-dash.stub.boards`) holds 6 Text panels: 4 copies of
 * the gallery's 2 KiB runbook, a 16 KiB and a 64 KiB `benchInput` (64 bytes short of each, so the
 * typed characters keep them in their buckets and within the content limit), each with an `Env $env` line and
 * no data panel. Steps:
 *
 * - `open`: a new context (nothing cached), the board, until the 6 panels show content.
 * - `var`: 5 filter-bar changes of `env`, each to a distinct value, so every render misses the memo.
 * - `type16`, `type64`: 10 characters typed into the 16 KiB panel's editor, 5 into the 64 KiB one's.
 *
 * Per step: the `markdown:render:<bucket>` measures (`TextMarkdown`, stub and dev builds only: a memo
 * miss each) as p50, p95 and max per bucket; the main-thread tasks over 16 ms (wall and thread) from
 * a Chromium trace between the step's marks; the click or keydown `EventLatency` p95. The report goes
 * to stdout and `test-results/text-render.json`. The click latency is `MOUSE_RELEASED`'s, the keydown
 * latency `KEY_PRESSED`'s.
 *
 * `enforce` fails when `le4k` or `le16k` renders have a p95 over 16 ms, when a step without a 64 KiB
 * render has a task over 16 ms, or when `le64k` renders have a p95 over 16 ms. A miss names the
 * mitigation rung (M1: the module-worker plan; M2: commit slices) for a follow-up issue.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { eventLatencies } from '../scripts/eventLatency.ts';
import type { TraceEvent } from '../scripts/longTasks.ts';
import { RUNBOOK } from '../src/dev/widgetGallery.ts';
import { t } from '../src/i18n/t.ts';
import { benchInput } from '../src/security/sanitise/benchInputs.ts';
import { BOARD_TIME } from './helpers.ts';

const enforce = process.env['LONG_TASK_GATE'] === 'enforce';
const BUDGET_MS = 16;
const UID = 'b-text-bench';
const CATEGORIES = [
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'blink.user_timing',
  'cc',
  'benchmark',
  'input',
];
const BUCKETS = ['le4k', 'le16k', 'le64k'] as const;
type Bucket = (typeof BUCKETS)[number];

const ENV = 'Env $env\n\n';
/** 64 bytes short of 16 and 64 KiB, so the typed characters keep each in its bucket and valid. */
const SIZE_16 = 16 * 1024 - 64;
const SIZE_64 = 64 * 1024 - 64;
const panel = (n: number, title: string, content: string) => ({
  id: `p-${String(n)}`,
  title,
  grid: { x: ((n - 1) % 2) * 6, y: Math.floor((n - 1) / 2) * 8, w: 6, h: 8 },
  vis: { kind: 'text', options: { mode: 'markdown', content } },
});
const BOARD_P = {
  uid: UID,
  title: 'Text render bench',
  updatedAt: '2026-11-19T12:00:00.000Z',
  spec: {
    title: 'Text render bench',
    panels: [
      panel(1, 'Runbook 1', `${ENV}${RUNBOOK}`),
      panel(2, 'Runbook 2', `${ENV}${RUNBOOK}`),
      panel(3, 'Runbook 3', `${ENV}${RUNBOOK}`),
      panel(4, 'Runbook 4', `${ENV}${RUNBOOK}`),
      panel(5, 'Notes 16 KiB', ENV + benchInput(1, SIZE_16 - ENV.length)),
      panel(6, 'Notes 64 KiB', ENV + benchInput(2, SIZE_64 - ENV.length)),
    ],
    sections: [],
  },
};

interface Stats {
  n: number;
  p50: number;
  p95: number;
  max: number;
}
interface StepReport {
  render: Partial<Record<Bucket, Stats>>;
  longTasks: { durMs: number; threadMs: number | null }[];
  eventLatencyP95: number | null;
}

const pct = (sorted: readonly number[], p: number): number =>
  sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? 0;

function stats(xs: readonly number[]): Stats {
  const s = [...xs].sort((a, b) => a - b);
  return { n: s.length, p50: pct(s, 0.5), p95: pct(s, 0.95), max: s.at(-1) ?? 0 };
}

/** The page's main thread (the one with the step's start mark) and its tasks over 16 ms. */
function tasksBetween(events: readonly TraceEvent[], start: string, end: string) {
  const key = (e: TraceEvent) => `${String(e.pid)}:${String(e.tid)}`;
  const mark = events.find((e) => e.name === start);
  if (mark === undefined) throw new Error(`no User Timing mark ${start}`);
  const main = key(mark);
  const onMain = events.filter((e) => key(e) === main);
  const t0 = Math.min(...onMain.filter((e) => e.name === start).map((e) => e.ts));
  const ends = onMain.filter((e) => e.name === end).map((e) => e.ts);
  if (ends.length === 0) throw new Error(`no User Timing mark ${end}`);
  const t1 = Math.max(...ends);
  return onMain
    .filter((e) => e.ph === 'X' && e.name === 'RunTask' && e.ts < t1 && e.ts + (e.dur ?? 0) > t0)
    .filter((e) => (e.dur ?? 0) > BUDGET_MS * 1000)
    .map((e) => ({
      durMs: (e.dur ?? 0) / 1000,
      threadMs: e.tdur === undefined ? null : e.tdur / 1000,
    }));
}

async function mark(page: Page, name: string): Promise<void> {
  await page.evaluate((n) => {
    performance.mark(n);
  }, name);
}

/** Runs `act` between `bench:<step>:start` and `:end` under a trace, and reports the step. */
async function step(
  browser: Browser,
  page: Page,
  name: string,
  latencyTypes: readonly string[],
  act: () => Promise<void>,
  opts: { traceStarted?: boolean } = {},
): Promise<StepReport> {
  if (opts.traceStarted !== true) {
    await page.evaluate(() => {
      performance.clearMeasures();
    });
    await browser.startTracing(page, { categories: CATEGORIES });
    await mark(page, `bench:${name}:start`);
  }
  await act();
  // Two frames, so the last commit has painted.
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
  await mark(page, `bench:${name}:end`);
  const trace = JSON.parse(String(await browser.stopTracing())) as { traceEvents: TraceEvent[] };
  const measures = await page.evaluate(() =>
    performance
      .getEntriesByType('measure')
      .filter((m) => m.name.startsWith('markdown:render:'))
      .map((m) => ({ name: m.name.slice('markdown:render:'.length), ms: m.duration })),
  );
  const render: Partial<Record<Bucket, Stats>> = {};
  for (const b of BUCKETS) {
    const xs = measures.filter((m) => m.name === b).map((m) => m.ms);
    if (xs.length > 0) render[b] = stats(xs);
  }
  let latency: number | null = null;
  if (latencyTypes.length > 0) {
    const ls = eventLatencies(trace.traceEvents, { types: latencyTypes }).sort((a, b) => a - b);
    latency = ls.length === 0 ? null : pct(ls, 0.95);
  }
  return {
    render,
    longTasks: tasksBetween(trace.traceEvents, `bench:${name}:start`, `bench:${name}:end`),
    eventLatencyP95: latency,
  };
}

const contents = (page: Page) => page.locator('[data-text-content]');

test('bench:text-widget-render (report-only; LONG_TASK_GATE=enforce fails a miss)', async ({
  browser,
}, info) => {
  test.setTimeout(240_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1600 } });
  await context.addInitScript((board) => {
    localStorage.setItem('pulsus-dash.stub.boards', JSON.stringify([board]));
    if (location.pathname.startsWith('/t/')) performance.mark('bench:open:start');
  }, BOARD_P);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const report = new Map<string, StepReport>();
  try {
    await browser.startTracing(page, { categories: CATEGORIES });
    report.set(
      'open',
      await step(
        browser,
        page,
        'open',
        [],
        async () => {
          await page.goto(`/t/demo/board/${UID}?${BOARD_TIME}&var-env=prod`);
          await expect(contents(page)).toHaveCount(6);
          await expect(contents(page).filter({ hasText: 'Env prod' })).toHaveCount(6);
        },
        { traceStarted: true },
      ),
    );

    report.set(
      'var',
      await step(browser, page, 'var', ['MOUSE_RELEASED'], async () => {
        let value = 'prod';
        for (let i = 1; i <= 5; i++) {
          const next = `v${String(i)}`;
          await page
            .getByRole('button', { name: t('filters.variable', { name: 'env', value }) })
            .click();
          const dialog = page.getByRole('dialog', {
            name: t('filters.variableTitle', { name: 'env' }),
          });
          await dialog.getByRole('textbox', { name: t('filters.value') }).fill(next);
          await dialog.getByRole('button', { name: t('filters.apply') }).click();
          await expect(contents(page).filter({ hasText: `Env ${next}` })).toHaveCount(6);
          value = next;
        }
      }),
    );

    await page.getByRole('button', { name: 'Edit board' }).click();
    const type = async (title: string, n: number): Promise<void> => {
      await page.getByRole('button', { name: t('panel.menu', { title }) }).click();
      await page.getByRole('menuitem', { name: t('panel.editPanel') }).click();
      const editor = page.getByRole('dialog', { name: t('widget.text.editTitle') });
      const box = editor.getByRole('textbox', { name: t('widget.text.content') });
      await box.focus();
      await page.keyboard.press('ControlOrMeta+End');
      for (let i = 0; i < n; i++) await page.keyboard.type('z', { delay: 50 });
      await expect(editor.locator('[data-text-content]')).toContainText('z'.repeat(n));
      await editor.getByRole('button', { name: t('editor.close') }).click();
    };
    report.set(
      'type16',
      await step(browser, page, 'type16', ['KEY_PRESSED'], () => type('Notes 16 KiB', 10)),
    );
    report.set(
      'type64',
      await step(browser, page, 'type64', ['KEY_PRESSED'], () => type('Notes 64 KiB', 5)),
    );
  } finally {
    await context.close();
  }

  const result = {
    bench: 'text-widget-render',
    mode: enforce ? 'enforce' : 'report',
    unit: 'ms',
    steps: Object.fromEntries(report),
  };
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/text-render.json', `${JSON.stringify(result, null, 2)}\n`);
  console.info(`bench:text-widget-render\n${JSON.stringify(result, null, 2)}`);
  expect(errors).toEqual([]);

  // The measures exist: every step rendered, each bucket it changes was measured.
  const measured = (name: string): readonly string[] =>
    Object.keys(report.get(name)?.render ?? {}).sort();
  expect(measured('open')).toEqual(['le16k', 'le4k', 'le64k']);
  expect(measured('var')).toEqual(['le16k', 'le4k', 'le64k']);
  expect(report.get('type16')?.render.le16k?.n ?? 0).toBeGreaterThan(0);
  expect(report.get('type64')?.render.le64k?.n ?? 0).toBeGreaterThan(0);

  const misses: string[] = [];
  for (const [name, r] of report) {
    for (const b of ['le4k', 'le16k'] as const) {
      const p95 = r.render[b]?.p95 ?? 0;
      if (p95 > BUDGET_MS) misses.push(`${name} ${b} render p95 ${p95.toFixed(1)} ms (M1)`);
    }
    const p95 = r.render.le64k?.p95 ?? 0;
    if (p95 > BUDGET_MS) misses.push(`${name} le64k render p95 ${p95.toFixed(1)} ms (M1)`);
    if (r.render.le64k === undefined) {
      for (const x of r.longTasks) {
        misses.push(
          `${name} long task ${x.durMs.toFixed(1)} ms wall (M2 if the renders are within 16 ms)`,
        );
      }
    }
  }
  for (const m of misses)
    info.annotations.push({ type: 'warning', description: `bench:text-widget-render miss: ${m}` });
  if (enforce) expect(misses).toEqual([]);
});
