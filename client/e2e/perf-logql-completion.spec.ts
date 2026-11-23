/**
 * `bench:logql-completion-latency` (T09-007, T09 §7; plan #66 Part A A.8.2; Chromium only, stub
 * build): keydown to completion popup on the dev-only LogQL editor harness, whose in-memory source
 * answers at once, so the client alone is timed. The probe, trial and summary helpers are in
 * `completionLatency.ts` (shared with `bench:promql-completion-latency`, #107).
 *
 * - **Local** (30 trials): `|` after `{app="web"} ` opens the stage list from the synchronous slot.
 * - **Remote** (30 trials): `w` inside `{app=""}` opens the label values after the 120 ms debounce.
 *
 * Always: 30 + 30 samples and remote min ≥ 120 ms (the debounce is never skipped). With
 * `EDITOR_BENCH_GATE=enforce` (the reference lab and the local D13 proofs): local p95 ≤ 16 ms and
 * remote p95 ≤ 136 ms; otherwise each breach is a `warning` annotation.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  DEBOUNCE_MS,
  frames,
  LOCAL_P95_MS,
  openProbed,
  REMOTE_P95_MS,
  summary,
  trial,
  TRIALS,
} from './completionLatency.ts';

const enforce = process.env['EDITOR_BENCH_GATE'] === 'enforce';

const harness = (doc: string) => `/t/demo/dev/logql-editor?q=${encodeURIComponent(doc)}`;

test('bench:logql-completion-latency', async ({ page }, info) => {
  test.setTimeout(120_000);

  await openProbed(page, harness('{app="web"} '), 'LogQL query', 0);
  for (let i = 0; i < TRIALS; i++) {
    await trial(page, '|');
    await frames(page);
  }
  const local = await page.evaluate(() => [...window.__lat]);

  await openProbed(page, harness('{app=""}'), 'LogQL query', 2);
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
