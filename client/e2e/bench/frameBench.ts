/**
 * The frame-bench harness (plan #68 C2d1 §1, §3.1; T05 §4.3 `bench:frame-gallery`,
 * `bench:frame-line-1e8`; ADR-0019). `drive` runs a script of steps inside the page, one step per
 * animation frame (an open loop: Playwright round trips do not pace it, and neither does the
 * engine), each a synthetic wheel, pointer drag or hover on the frame's canvas at the plot's centre
 * (`data-plot` of the canvas or its frame). A `PerformanceObserver` collects the frame's
 * `chart-present` marks (both renderers mark the presented frame where they emit `drawn`) and its
 * `chart-draw` measures, filtered by `detail.frame`. After the script it keeps collecting until the
 * frame has presented twice or the case's time box runs out (`timedOut`, not a failure). `report`
 * appends the results to `test-results/bench/<gate>.json` and annotates the test, with PRF-001
 * and PRF-002 marked `ok`, `over` or `n/a`: the gates are report-only.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { expect, type Page, type TestInfo } from '@playwright/test';
import {
  budgets,
  collectUntil,
  type BenchGate,
  type BenchResult,
  type Drive,
} from '../../scripts/lib/benchStats.ts';

export type { Drive } from '../../scripts/lib/benchStats.ts';

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

/** After the last step: two frames, then this long (the wheel commit is 300 ms). */
export const SETTLE_MS = 500;
/** A case's time box: a gallery case, a 10⁸ case (plan #68 C2d1 §3.1). */
export const GALLERY_BOX_MS = 60_000;
export const LINE_1E8_BOX_MS = 120_000;
/** Presents `drive` waits for after the script. */
export const MIN_PRESENTS = 2;

interface DriveArgs {
  sel: string;
  frameId: string;
  steps: readonly Step[];
  settleMs: number;
  boxMs: number;
  min: number;
}

/** `drive`'s body, run in the page with `collectUntil`'s source (no imports reach the page). */
const inPage = async (collect: typeof collectUntil, a: DriveArgs): Promise<Drive> => {
  const t0 = performance.now();
  const c = document.querySelector<HTMLCanvasElement>(a.sel);
  if (c === null) throw new Error(`drive: no canvas ${a.sel}`);
  const plot = (): [number, number, number, number] => {
    const host = c.closest<HTMLElement>('[data-plot]');
    const [x = 0, y = 0, w = 0, h = 0] = (host?.dataset['plot'] ?? '').split(',').map(Number);
    return [x, y, w, h];
  };
  const presents: number[] = [];
  const draws: { start: number; end: number }[] = [];
  const take = (list: PerformanceEntryList): void => {
    for (const e of list) {
      const d = (e as PerformanceMark).detail as { frame?: unknown } | null;
      if (d?.frame !== a.frameId) continue;
      if (e.name === 'chart-present') presents.push(e.startTime);
      else if (e.name === 'chart-draw')
        draws.push({ start: e.startTime, end: e.startTime + e.duration });
    }
  };
  const obs = new PerformanceObserver((l) => {
    take(l.getEntries());
  });
  obs.observe({ entryTypes: ['mark', 'measure'] });
  const frame = (): Promise<number> =>
    new Promise((r) => {
      requestAnimationFrame(r);
    });
  const client = (x: number, y: number) => {
    const r = c.getBoundingClientRect();
    return { clientX: r.left + x, clientY: r.top + y };
  };
  const pointer = (type: string, x: number, y: number, buttons: number): void => {
    c.dispatchEvent(
      new PointerEvent(type, {
        ...client(x, y),
        button: 0,
        buttons,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  };
  let start = t0;
  let steps = 0;
  let timedOut = false;
  let drag: { x: number; y: number } | null = null;
  for (let k = 0; k < a.steps.length; k++) {
    await frame();
    if (k === 0) start = performance.now();
    if (performance.now() - t0 > a.boxMs) {
      timedOut = true;
      break;
    }
    const s = a.steps[k];
    if (s === undefined) break;
    const [px, py, pw, ph] = plot();
    const cx = px + pw / 2;
    const cy = py + ph / 2;
    if (s.kind !== 'drag' && drag !== null) {
      pointer('pointerup', drag.x, drag.y, 0);
      drag = null;
    }
    switch (s.kind) {
      case 'wheel':
        c.dispatchEvent(
          new WheelEvent('wheel', {
            ...client(cx, cy),
            deltaX: s.dx ?? 0,
            deltaY: s.dy,
            deltaMode: 0,
            shiftKey: s.shift ?? false,
            bubbles: true,
            cancelable: true,
          }),
        );
        break;
      case 'drag':
        if (drag === null) {
          drag = { x: cx, y: cy };
          pointer('pointerdown', drag.x, drag.y, 1);
        }
        drag = { x: drag.x + s.dx, y: drag.y };
        pointer('pointermove', drag.x, drag.y, 1);
        break;
      case 'hover':
        pointer('pointermove', px + s.fx * pw, py + s.fy * ph, 0);
        break;
    }
    steps += 1;
  }
  if (drag !== null) pointer('pointerup', drag.x, drag.y, 0);
  await frame();
  await frame();
  await new Promise((r) => setTimeout(r, a.settleMs));
  if (!timedOut) {
    // A slow engine (seconds per frame at 10⁸) still yields its frames, within the box.
    timedOut = await collect(
      {
        now: () => performance.now(),
        wait: (ms) =>
          new Promise((r) => {
            setTimeout(r, ms);
          }),
      },
      () => {
        take(obs.takeRecords());
        return presents.length;
      },
      { start: t0, boxMs: a.boxMs, min: a.min, pollMs: 50 },
    );
  }
  take(obs.takeRecords());
  obs.disconnect();
  return { presents, draws, span: { start, end: performance.now() }, steps, timedOut };
};

/**
 * Runs `steps` on the canvas `canvas` (a selector) in the page, step k in the k-th animation
 * frame, then waits two frames and `SETTLE_MS`, then until the frame has presented
 * `MIN_PRESENTS` times. Each step acts at the plot's centre (`data-plot` of the canvas or its
 * frame, read at the step): a wheel there, a drag from there (pointerdown, one move per step,
 * pointerup when the drag steps end) or a hover at `(fx, fy)` of the plot. Collects the
 * `chart-present` marks and `chart-draw` measures whose `detail.frame` is `frameId`; the span runs
 * from the first step's frame (or the call, with no steps) to the end. When `boxMs` passes first
 * (from the call), it stops with what it has and `timedOut`.
 */
export async function drive(
  page: Page,
  canvas: string,
  frameId: string,
  steps: readonly Step[],
  boxMs: number,
): Promise<Drive> {
  const args: DriveArgs = {
    sel: canvas,
    frameId,
    steps,
    settleMs: SETTLE_MS,
    boxMs,
    min: MIN_PRESENTS,
  };
  // A string expression: the page gets `collectUntil` as source (CDP evaluation, not page eval).
  return page.evaluate<Drive>(
    `(${inPage.toString()})(${collectUntil.toString()}, ${JSON.stringify(args)})`,
  );
}

/**
 * Opens `url` and waits for a frame's first `a11y` (`data-frame-ready`), and on a probe page for
 * `__dashProbe`. Never Playwright's fake clock: it hides the User Timing entries `drive` collects.
 */
export async function open(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.locator('html[data-shell-ready="true"]').waitFor();
  if (url.includes('probe=1')) await page.waitForFunction(() => '__dashProbe' in window);
  await expect(page.locator('[data-chart-frame][data-frame-ready="true"]').first()).toBeVisible();
}

const fmt = (v: number | null): string => (v !== null && Number.isFinite(v) ? v.toFixed(1) : '–');

/** One result as a line: the percentiles and PRF-001 / PRF-002 as `ok`, `over` or `n/a`. */
export function describeResult(r: BenchResult): string {
  if (r.skipped !== undefined) return `${r.case} ${r.leg}: skipped (${r.skipped})`;
  const i = r.intervalMs;
  const b = budgets(r);
  return (
    `${r.case} ${r.leg} (${String(r.series)} series, ${String(r.points)} points): ` +
    `interval p50 ${fmt(i.p50)} p95 ${fmt(i.p95)} p99 ${fmt(i.p99)} max ${fmt(i.max)} ms; ` +
    `draw p50 ${fmt(r.drawMs.p50)} p95 ${fmt(r.drawMs.p95)} p99 ${fmt(r.drawMs.p99)} max ${fmt(r.drawMs.max)} ms; ` +
    `${String(r.frames)} frames for ${String(r.steps)} steps (coalescing ${fmt(r.coalescing)}), ` +
    `${String(r.over1)} > 16.7 ms, ${String(r.over2)} > 33.4 ms` +
    (r.hovers === undefined ? '' : `, ${String(r.hovers)} hovers`) +
    `${r.timedOut === true ? ', timed out' : ''}; PRF-001 ${b.prf001}, PRF-002 ${b.prf002}`
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

/** The fields of a `BenchResult` (`hovers`, `timedOut` and `skipped` are optional). */
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
  'steps',
  'coalescing',
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
