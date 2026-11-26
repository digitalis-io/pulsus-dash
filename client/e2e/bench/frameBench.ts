/**
 * The frame-bench harness (plan #68 C2d1 §1, §3.1; T05 §4.3 `bench:frame-gallery`,
 * `bench:frame-line-1e8`; ADR-0019). `drive` runs a script of steps inside the page, one step per
 * animation frame, so Playwright round trips do not pace it: each step is a synthetic wheel,
 * pointer drag or hover on the frame's canvas at the plot's centre (`data-plot` of the canvas or
 * its frame). A `PerformanceObserver` collects the frame's `chart-present` marks (both renderers
 * mark the presented frame where they emit `drawn`) and its `chart-draw` measures, filtered by
 * `detail.frame`. `report` appends the results to `test-results/bench/<gate>.json` and annotates
 * the test, with PRF-001 and PRF-002 marked `ok` or `over`: the gates are report-only.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import type { BenchGate, BenchResult, Span } from '../../scripts/lib/benchStats.ts';

export type Step =
  | { kind: 'wheel'; dy: number; dx?: number; shift?: boolean }
  | { kind: 'drag'; dx: number }
  | { kind: 'hover'; fx: number; fy: number };

/** 40 wheel zoom-ins, a 40-step drag pan, 40 wheel zoom-outs: 120 steps. */
export const SCRIPT: readonly Step[] = [
  ...Array.from({ length: 40 }, (): Step => ({ kind: 'wheel', dy: -120 })),
  ...Array.from({ length: 40 }, (): Step => ({ kind: 'drag', dx: -20 })),
  ...Array.from({ length: 40 }, (): Step => ({ kind: 'wheel', dy: 120 })),
];

/** 120 hover steps: fx 0.05 → 0.95 in 60 steps and back, no two in a row at the same x. */
export const HOVER: readonly Step[] = [
  ...Array.from({ length: 60 }, (_, k): Step => ({
    kind: 'hover',
    fx: 0.05 + (0.9 * k) / 59,
    fy: 0.5,
  })),
  ...Array.from({ length: 60 }, (_, k): Step => ({
    kind: 'hover',
    fx: 0.95 - (0.9 * (k + 1)) / 60,
    fy: 0.5,
  })),
];

/** What `drive` collected: page-clock times (ms) of the marks and measures, and the span. */
export interface Driven {
  presents: number[];
  draws: { start: number; end: number }[];
  span: Span;
}

/**
 * Runs `steps` on the canvas `canvas` (a selector) in the page, step k in the k-th animation
 * frame, then waits two frames and 500 ms (the wheel commit is 300 ms). Collects the
 * `chart-present` marks and `chart-draw` measures of frame `frameId` over that span.
 */
export async function drive(
  page: Page,
  canvas: string,
  frameId: string,
  steps: readonly Step[],
): Promise<Driven> {
  // Test-first stub: nothing is driven or collected.
  await page.evaluate(() => undefined);
  return { presents: [], draws: [], span: { start: 0, end: steps.length * 0 } };
}

/** PRF-001: p50 interval ≤ 16.7 ms; PRF-002: p99 ≤ 22.2 ms. */
export const PRF_001_MS = 16.7;
export const PRF_002_MS = 22.2;

const fmt = (v: number): string => (Number.isFinite(v) ? v.toFixed(1) : '–');

/** One result as a line: the percentiles and PRF-001 / PRF-002 marked `ok` or `over`. */
export function describeResult(r: BenchResult): string {
  if (r.skipped !== undefined) return `${r.case} ${r.leg}: skipped (${r.skipped})`;
  const i = r.intervalMs;
  const prf1 = i.p50 <= PRF_001_MS ? 'ok' : 'over';
  const prf2 = i.p99 <= PRF_002_MS ? 'ok' : 'over';
  return (
    `${r.case} ${r.leg} (${String(r.series)} series, ${String(r.points)} points): ` +
    `interval p50 ${fmt(i.p50)} p95 ${fmt(i.p95)} p99 ${fmt(i.p99)} max ${fmt(i.max)} ms; ` +
    `draw p50 ${fmt(r.drawMs.p50)} p95 ${fmt(r.drawMs.p95)} p99 ${fmt(r.drawMs.p99)} max ${fmt(r.drawMs.max)} ms; ` +
    `${String(r.frames)} frames, ${String(r.over1)} > 16.7 ms, ${String(r.over2)} > 33.4 ms; ` +
    `PRF-001 ${prf1}, PRF-002 ${prf2}`
  );
}

/** `test-results/bench/<gate>.json` (relative to the client directory). */
export function benchFile(gate: BenchGate): string {
  return `test-results/bench/${gate.replace(':', '-')}.json`;
}

export function readResults(gate: BenchGate): BenchResult[] {
  const p = benchFile(gate);
  if (!existsSync(p)) return [];
  return JSON.parse(readFileSync(p, 'utf8')) as BenchResult[];
}

/** Appends the results to their gate's JSON and annotates the test (one line each). */
export async function report(info: TestInfo, results: readonly BenchResult[]): Promise<void> {
  const gates = [...new Set(results.map((r) => r.gate))];
  for (const gate of gates) {
    const p = benchFile(gate);
    mkdirSync(dirname(p), { recursive: true });
    const all = [...readResults(gate), ...results.filter((r) => r.gate === gate)];
    writeFileSync(p, `${JSON.stringify(all, null, 2)}\n`);
  }
  for (const r of results) {
    const line = describeResult(r);
    console.log(`${r.gate} (report only): ${line}`);
    info.annotations.push({ type: r.gate, description: line });
  }
  await Promise.resolve();
}

/** The fields of a `BenchResult` (`skipped` is optional). */
export const RESULT_FIELDS = [
  'gate',
  'case',
  'leg',
  'points',
  'series',
  'frames',
  'intervalMs',
  'drawMs',
  'over1',
  'over2',
] as const;

/**
 * What the gate's JSON lacks: each wanted `case leg` without a result, and each result without a
 * field (or a percentile of `intervalMs` / `drawMs`).
 */
export function reportGaps(
  results: readonly BenchResult[],
  want: readonly { case: string; leg: string }[],
): string[] {
  const out: string[] = [];
  for (const w of want) {
    if (!results.some((r) => r.case === w.case && r.leg === w.leg))
      out.push(`no result for ${w.case} ${w.leg}`);
  }
  for (const r of results) {
    const o = r as unknown as Record<string, unknown>;
    for (const f of RESULT_FIELDS) if (!(f in o)) out.push(`${r.case} ${r.leg}: no ${f}`);
    for (const f of ['intervalMs', 'drawMs'] as const) {
      const pct = o[f] as Record<string, unknown> | undefined;
      for (const k of ['p50', 'p95', 'p99', 'max'])
        if (pct === undefined || !(k in pct)) out.push(`${r.case} ${r.leg}: no ${f}.${k}`);
    }
  }
  return out;
}
