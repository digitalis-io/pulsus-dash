/**
 * `bench:promql-completion-latency` (T09-007, T09-008, T09 §7, PRF-005; plan #107 §5.3; Chromium
 * only, stub build): keydown to completion popup in the Explore › Metrics editor, whose source
 * (`createPromSource` over `StubApi`) answers at once, so the client alone is timed. No fake clock.
 *
 * - **Local** (30 trials): `r` in `sum(‸up)` at the end of a 1 022-byte query opens the function
 *   list from slot 0, while the metric names wait in slot 1.
 * - **Remote** (30 trials): `a` inside `up{job=""}` opens the label values after the 120 ms
 *   debounce.
 * - **Work per local key** (`keyWork`): the editor probe (each `view.update`: `doc` when it changes
 *   the document, else `view`) and the completion probe (`slot0`, `slot1pre`, `slot1post`) push
 *   `[time, ms, kind]` to `window.__work`. `keyWork` sums every entry from the key's keydown to its
 *   popup except `slot1post`: the key's document update, its local completion work and the popup
 *   render. `remoteWork` (reported only) is `slot1post` plus `view` from the 120 ms timer to the
 *   merged list.
 * - **Long tasks** (PRF-005): a Chromium trace of every trial, read by `scripts/longTasks.ts`.
 *
 * Always (blocking): 30 + 30 samples, remote min ≥ 120 ms, local p50 < 100 ms (a list held behind
 * the 120 ms typing delay or CodeMirror's 100 ms sync wait gives every sample ≥ 100 ms), `ciOver`
 * 0, and every `keyWork` sample with a `doc` and a `slot0` entry. `EDITOR_BENCH_GATE=enforce`:
 * local p95 ≤ 16 ms, remote p95 ≤ 136 ms, `over16` 0 and `keyWork` p95 ≤ 2 ms; otherwise each
 * breach is a `warning` annotation.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { parser } from '@prometheus-io/lezer-promql';
import { longTasks, type TraceEvent } from '../scripts/longTasks.ts';
import {
  DEBOUNCE_MS,
  frames,
  LOCAL_P95_MS,
  openProbed,
  percentile,
  REMOTE_P95_MS,
  summary,
  trial,
  TRIALS,
} from './completionLatency.ts';

const enforce = process.env['EDITOR_BENCH_GATE'] === 'enforce';
const LOCAL_P50_MS = 100;
const KEY_WORK_P95_MS = 2;
const CATEGORIES = [
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'blink.user_timing',
];

/** 203 `up + ` and `sum(up)`: 1 022 bytes, one valid query. */
const Q1K_LOCAL = `${'up + '.repeat(203)}sum(up)`;

const metrics = (q: string) =>
  `/t/demo/explore/metrics?from=now-1h&to=now&refresh=off&q=${encodeURIComponent(q)}`;

type WorkKind = 'doc' | 'view' | 'slot0' | 'slot1pre' | 'slot1post';
type Work = [number, number, WorkKind];

declare global {
  interface Window {
    __work: Work[];
    __pulsusEditorProbe: (ms: number, docChanged: boolean) => void;
    __pulsusCompletionProbe: (ms: number, part: 'slot0' | 'slot1pre' | 'slot1post') => void;
  }
}

/** The entries of `work` that end in `[from, to]` and are of one of `kinds`. */
const within = (work: readonly Work[], from: number, to: number, kinds: readonly WorkKind[]) =>
  work.filter(([t, , k]) => t >= from && t <= to && kinds.includes(k));

const sum = (ws: readonly Work[]) => ws.reduce((a, [, ms]) => a + ms, 0);

async function ready(page: Page): Promise<void> {
  await expect(page.locator('[data-chart-frame][data-frame-ready="true"]')).toBeVisible();
}

test('bench:promql-completion-latency', async ({ page }, info) => {
  test.setTimeout(120_000);
  expect(new TextEncoder().encode(Q1K_LOCAL).length).toBe(1022);
  const errors: number[] = [];
  parser.parse(Q1K_LOCAL).iterate({
    enter: (n) => {
      if (n.type.isError) errors.push(n.from);
    },
  });
  expect(errors).toEqual([]);

  await page.addInitScript(() => {
    window.__work = [];
    window.__pulsusEditorProbe = (ms, docChanged) => {
      window.__work.push([performance.now(), ms, docChanged ? 'doc' : 'view']);
    };
    window.__pulsusCompletionProbe = (ms, part) => {
      window.__work.push([performance.now(), ms, part]);
    };
  });

  const browser = page.context().browser();
  if (browser === null) throw new Error('no browser to trace');

  // Caret before the last `up)`: `sum(‸up)`.
  await openProbed(page, metrics(Q1K_LOCAL), 'PromQL query', 3);
  await ready(page);
  await browser.startTracing(page, { categories: CATEGORIES });
  for (let i = 0; i < TRIALS; i++) {
    await trial(page, 'r');
    await frames(page);
  }
  const local = await page.evaluate(() => ({
    lat: [...window.__lat],
    spans: [...window.__spans],
    work: [...window.__work],
  }));

  // Caret between the quotes.
  await openProbed(page, metrics('up{job=""}'), 'PromQL query', 2);
  await ready(page);
  for (let i = 0; i < TRIALS; i++) {
    await trial(page, 'a');
    await page.waitForTimeout(200);
  }
  const remote = await page.evaluate(() => ({
    lat: [...window.__lat],
    spans: [...window.__spans],
    work: [...window.__work],
  }));
  const trace = JSON.parse(String(await browser.stopTracing())) as { traceEvents: TraceEvent[] };
  const r = longTasks(trace.traceEvents);

  const keyKinds: WorkKind[] = ['doc', 'view', 'slot0', 'slot1pre'];
  const perKey = local.spans.map(([down, shown]) => {
    const ws = within(local.work, down, shown, keyKinds);
    return {
      keyWork: sum(ws),
      docMs: sum(ws.filter(([, , k]) => k === 'doc')),
      completionMs: sum(ws.filter(([, , k]) => k === 'slot0' || k === 'slot1pre')),
      docs: ws.filter(([, , k]) => k === 'doc').length,
      slot0s: ws.filter(([, , k]) => k === 'slot0').length,
    };
  });
  const remoteWork = remote.spans.map(([down, shown]) =>
    sum(within(remote.work, down + DEBOUNCE_MS, shown, ['slot1post', 'view'])),
  );
  const p95 = (xs: readonly number[]) =>
    percentile(
      [...xs].sort((a, b) => a - b),
      95,
    );

  const report = {
    local: summary(local.lat),
    remote: summary(remote.lat),
    keyWork: summary(perKey.map((k) => k.keyWork)),
    docMs: { p95: p95(perKey.map((k) => k.docMs)) },
    completionMs: { p95: p95(perKey.map((k) => k.completionMs)) },
    remoteWork: summary(remoteWork),
    longTasks: r.over16,
    ciOver: r.ciOver,
    windowMs: r.windowMs,
    mode: enforce ? 'enforce' : 'ci',
  };
  mkdirSync('test-results', { recursive: true });
  writeFileSync(
    'test-results/bench-promql-completion.json',
    `${JSON.stringify(report, null, 2)}\n`,
  );
  const ms = (x: number) => x.toFixed(2);
  info.annotations.push({
    type: 'bench:promql-completion-latency',
    description: `local p50 ${ms(report.local.p50)} ms, p95 ${ms(report.local.p95)} ms; remote p50 ${ms(report.remote.p50)} ms, p95 ${ms(report.remote.p95)} ms, min ${ms(Math.min(...remote.lat))} ms; keyWork p50 ${ms(report.keyWork.p50)} ms, p95 ${ms(report.keyWork.p95)} ms (doc p95 ${ms(report.docMs.p95)}, completion p95 ${ms(report.completionMs.p95)}); remoteWork p95 ${ms(report.remoteWork.p95)} ms; ${String(r.over16)} tasks over 16 ms, ${String(r.ciOver)} over the CI check`,
  });

  expect(local.lat).toHaveLength(TRIALS);
  expect(remote.lat).toHaveLength(TRIALS);
  // The debounce is never skipped, and its timer never fires early.
  expect(Math.min(...remote.lat)).toBeGreaterThanOrEqual(DEBOUNCE_MS);
  // Neither the typing delay nor CodeMirror's sync wait holds the local list.
  expect(report.local.p50).toBeLessThan(LOCAL_P50_MS);
  // Both probes are wired: each key has its document update and its slot 0 work.
  expect(perKey).toHaveLength(TRIALS);
  expect(
    perKey.flatMap((k, i) =>
      k.docs >= 1 && k.slot0s >= 1
        ? []
        : [`key ${String(i)}: ${String(k.docs)} doc, ${String(k.slot0s)} slot0`],
    ),
    'each with a `slot0` entry',
  ).toEqual([]);
  const ci = r.tasks.filter((x) => x.durMs > 50 && (x.threadMs === null || x.threadMs > 16));
  expect(
    r.ciOver,
    ci.map((x) => `${x.durMs.toFixed(1)} ms wall, ${String(x.threadMs)} ms thread`).join('; '),
  ).toBe(0);

  const breaches = [
    ...(report.local.p95 > LOCAL_P95_MS
      ? [`local p95 ${ms(report.local.p95)} ms > ${String(LOCAL_P95_MS)} ms (T09 §7)`]
      : []),
    ...(report.remote.p95 > REMOTE_P95_MS
      ? [`remote p95 ${ms(report.remote.p95)} ms > ${String(REMOTE_P95_MS)} ms (T09-007)`]
      : []),
    ...(r.over16 > 0 ? [`${String(r.over16)} main-thread tasks over 16 ms (PRF-005)`] : []),
    ...(report.keyWork.p95 > KEY_WORK_P95_MS
      ? [`keyWork p95 ${ms(report.keyWork.p95)} ms > ${String(KEY_WORK_P95_MS)} ms (T09 §7)`]
      : []),
  ];
  if (enforce) expect(breaches).toEqual([]);
  else for (const b of breaches) info.annotations.push({ type: 'warning', description: b });
});
