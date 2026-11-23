/**
 * `bench:log-scroll` (plan #66 Part B, B.3; PRF-020, PRF-001, PRF-003, PRF-004, PRF-005; Chromium
 * only, stub build): the log stream on the dev-only harness holding 10⁶ synthetic entries.
 *
 * Phases: 0 ready (10⁶ held); 1 vsync calibrated at rest; 2 the same gesture on a static control
 * scroller (the browser's floor); 3 a 30 000 px scripted fling in the middle; 4 a fling across the
 * buffer end that loads, renders and evicts a page, the window running to 1 s after it lands;
 * 5 the trace: long tasks between the `bench:start` and `bench:end` marks and the scroll-update
 * `EventLatency` durations (input to presentation, the PRF-003 proxy: photons are not observable).
 *
 * Always: held at the cap, the load made, `ciOver` 0, at least 50 latencies. With
 * `LOG_BENCH_GATE=enforce` (the reference lab and the local D13 proofs), unrounded against the
 * calibrated vsync interval: fling median ≤ 1 vsync at ≥ 60 Hz, crossing ≤ 2 vsyncs, `EventLatency`
 * median ≤ 1 and p99 ≤ 2 vsyncs, no task over 16 ms; otherwise each breach is a `warning`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type CDPSession, type Page, type TestInfo } from '@playwright/test';
import { eventLatencies, SCROLL_UPDATE_TYPES } from '../scripts/eventLatency.ts';
import { longTasks, type TraceEvent } from '../scripts/longTasks.ts';
import { atRest, centre, openBench, scrollToOrd, state } from './logStreamBench.ts';

const enforce = process.env['LOG_BENCH_GATE'] === 'enforce';
/** Floating-point noise of rAF timestamps (ms): equal frame intervals compare equal. Not rounding. */
const EPS = 1e-6;
const CATEGORIES = [
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'blink.user_timing',
  'cc',
  'benchmark',
  'input',
  'input.scrolling',
];

declare global {
  interface Window {
    __frames?: number[];
    __recording?: boolean;
  }
}

function percentile(xs: readonly number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i] ?? 0;
}
const median = (xs: readonly number[]) => percentile(xs, 50);
const intervals = (ts: readonly number[]) => ts.slice(1).map((t, i) => t - (ts[i] ?? t));

async function recorder(page: Page, on: boolean): Promise<number[]> {
  return page.evaluate((start) => {
    if (start) {
      window.__frames = [];
      window.__recording = true;
      const tick = (t: number) => {
        if (window.__recording !== true) return;
        window.__frames?.push(t);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return [];
    }
    window.__recording = false;
    return window.__frames ?? [];
  }, on);
}

async function gesture(
  page: Page,
  cdp: CDPSession,
  selector = '[data-log-scroller]',
): Promise<void> {
  const c = await centre(page, selector);
  await cdp.send('Input.synthesizeScrollGesture', {
    x: c.x,
    y: c.y,
    yDistance: -30_000,
    speed: 6_000,
    gestureSourceType: 'mouse',
  });
}

/** Records a trace of `act` and returns its events. */
async function traced(page: Page, act: () => Promise<void>): Promise<TraceEvent[]> {
  const browser = page.context().browser();
  if (browser === null) throw new Error('no browser');
  await browser.startTracing(page, { categories: CATEGORIES });
  await act();
  return (JSON.parse(String(await browser.stopTracing())) as { traceEvents: TraceEvent[] })
    .traceEvents;
}

function check(info: TestInfo, ok: boolean, what: string): void {
  // Soft: every threshold is observed on its own, also when another one fails (D13).
  if (enforce) expect.soft(ok, what).toBe(true);
  else if (!ok)
    info.annotations.push({
      type: 'warning',
      description: `${what} (lab gate: LOG_BENCH_GATE=enforce)`,
    });
}

test('bench:log-scroll (functional always; lab thresholds with LOG_BENCH_GATE=enforce)', async ({
  page,
}, info) => {
  test.setTimeout(600_000);
  const cdp = await page.context().newCDPSession(page);

  // 0 ready.
  // The harness's default config (B.2): 10⁶ of 2 × 10⁶ entries, MAX_ENTRIES, 50 ms latency.
  await openBench(page, {}, 300_000);
  const ready = await state(page);
  expect(ready.held).toBe(1_000_000);
  expect(ready.firstOrd).toBe(0);

  // 1 calibrate.
  await scrollToOrd(page, 500_000);
  await atRest(page);
  await recorder(page, true);
  await page.waitForFunction(() => (window.__frames?.length ?? 0) >= 121, undefined, {
    timeout: 30_000,
  });
  const vsyncMs = median(intervals(await recorder(page, false)));
  expect(1000 / vsyncMs, `display rate (vsync ${vsyncMs.toFixed(2)} ms)`).toBeGreaterThanOrEqual(
    59,
  );

  // 2 control.
  await page.evaluate(() => {
    window.__logStreamBench?.showControl(true);
  });
  const controlEvents = await traced(page, () => gesture(page, cdp, '[data-log-control]'));
  const control = eventLatencies(controlEvents, { types: SCROLL_UPDATE_TYPES });
  await page.evaluate(() => {
    window.__logStreamBench?.showControl(false);
  });
  await scrollToOrd(page, 500_000);
  await atRest(page);

  let fling: number[] = [];
  let crossing: number[] = [];
  let calls = 0;
  const events = await traced(page, async () => {
    // 3 fling.
    await page.evaluate(() => performance.mark('bench:start'));
    await recorder(page, true);
    await gesture(page, cdp);
    fling = intervals(await recorder(page, false));

    // 4 crossing.
    await scrollToOrd(page, 997_500);
    await atRest(page);
    const calls0 = (await state(page)).calls;
    const endOrd0 = (await state(page)).endOrd;
    await recorder(page, true);
    await gesture(page, cdp);
    await page.waitForFunction(
      (e) => {
        const s = window.__logStreamBench?.state();
        return s !== undefined && s.tail === 'idle' && s.endOrd > e;
      },
      endOrd0,
      { timeout: 30_000, polling: 'raf' },
    );
    const landedAt = await page.evaluate(() => performance.now());
    await page.waitForFunction((t) => performance.now() >= t + 1000, landedAt, {
      polling: 'raf',
    });
    const frames = await recorder(page, false);
    const until = landedAt + 2 * vsyncMs;
    crossing = intervals(frames.filter((t) => t <= until));
    await page.evaluate(() => performance.mark('bench:end'));
    const s = await state(page);
    calls = s.calls - calls0;
    expect.soft(calls, 'the crossing made a request').toBeGreaterThan(0);
    expect.soft(s.endOrd - s.firstOrd, 'held after the crossing').toBe(1_000_000);
    expect.soft(s.firstOrd, 'a head page evicted').toBeGreaterThanOrEqual(1_000);
  });

  // 5 trace.
  const lt = longTasks(events, {
    inputs: ['wheel', 'scroll'],
    marks: { start: 'bench:start', end: 'bench:end' },
  });
  // The same trace on #90's window (first to last input): a task after the last input is outside.
  const inputWindow = longTasks(events, { inputs: ['wheel', 'scroll'] });
  const latency = eventLatencies(events, { types: SCROLL_UPDATE_TYPES });
  const report = {
    held: ready.held,
    vsyncMs,
    control: { medianMs: median(control), p99Ms: percentile(control, 99) },
    fling: { frames: fling.length, medianMs: median(fling), maxMs: Math.max(0, ...fling) },
    crossing: { frames: crossing.length, maxMs: Math.max(0, ...crossing), calls },
    eventLatency: {
      samples: latency.length,
      medianMs: median(latency),
      p99Ms: percentile(latency, 99),
    },
    longTasks: lt.over16,
    longTasksInputWindow: inputWindow.over16,
    // Each task over 16 ms as [start in trace µs, wall ms], in each window.
    tasks: lt.tasks.map((x) => [x.tsUs, Math.round(x.durMs * 10) / 10]),
    tasksInputWindow: inputWindow.tasks.map((x) => [x.tsUs, Math.round(x.durMs * 10) / 10]),
    ciOver: lt.ciOver,
    worstMs: lt.worstMs,
    windowMs: lt.windowMs,
    mode: enforce ? 'enforce' : 'ci',
  };
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/bench-log-scroll.json', `${JSON.stringify(report, null, 2)}\n`);
  info.annotations.push({
    type: 'bench:log-scroll',
    description: `vsync ${vsyncMs.toFixed(2)} ms; fling median ${report.fling.medianMs.toFixed(2)} ms; crossing max ${report.crossing.maxMs.toFixed(2)} ms; EventLatency median ${report.eventLatency.medianMs.toFixed(2)} ms, p99 ${report.eventLatency.p99Ms.toFixed(2)} ms (control ${report.control.medianMs.toFixed(2)} / ${report.control.p99Ms.toFixed(2)} ms); ${String(lt.over16)} tasks over 16 ms`,
  });

  // Always (after the report, so a failing run still records its numbers).
  expect.soft((lt.counts['wheel'] ?? 0) + (lt.counts['scroll'] ?? 0), 'inputs').toBeGreaterThan(0);
  expect.soft(lt.ciOver, 'ciOver').toBe(0);
  expect.soft(latency.length, 'EventLatency samples').toBeGreaterThanOrEqual(50);

  check(
    info,
    report.fling.medianMs <= vsyncMs + EPS && vsyncMs <= 1000 / 60 + EPS,
    `PRF-001: fling median ${report.fling.medianMs.toFixed(2)} ms ≤ vsync ${vsyncMs.toFixed(2)} ms at ≥ 60 Hz`,
  );
  check(
    info,
    report.crossing.maxMs <= 2 * vsyncMs + EPS,
    `PRF-020: crossing max ${report.crossing.maxMs.toFixed(2)} ms ≤ 2 vsyncs`,
  );
  check(
    info,
    report.eventLatency.medianMs <= vsyncMs + EPS,
    `PRF-003: EventLatency median ${report.eventLatency.medianMs.toFixed(2)} ms ≤ 1 vsync`,
  );
  check(
    info,
    report.eventLatency.p99Ms <= 2 * vsyncMs + EPS,
    `PRF-004: EventLatency p99 ${report.eventLatency.p99Ms.toFixed(2)} ms ≤ 2 vsyncs`,
  );
  check(info, lt.over16 === 0, `PRF-005: ${String(lt.over16)} tasks over 16 ms between the marks`);
});
