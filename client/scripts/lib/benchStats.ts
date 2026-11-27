/**
 * The frame benches' statistics (plan #68 C2d1 §3.1; T05 §4.3 `bench:frame-gallery`,
 * `bench:frame-line-1e8`): percentiles by nearest rank, one case's `BenchResult` from its
 * `chart-present` marks and `chart-draw` measures, the budgets' status and the collection rule
 * after a script (`collectUntil`). Pure: `e2e/bench/frameBench.ts` runs `collectUntil` in the page
 * and writes the results.
 */

export interface Pct {
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export type BenchGate = 'bench:frame-gallery' | 'bench:frame-line-1e8';
export type BenchLeg = 'wasm-webgl2' | 'wasm-webgpu' | 'canvas2d';

export interface BenchResult {
  gate: BenchGate;
  /** e.g. `line-50`, `line-50-hover`, `1e8-selected`. */
  case: string;
  leg: BenchLeg;
  points: number;
  series: number;
  /** `chart-present` marks inside the script's span. */
  frames: number;
  /** Between consecutive `chart-present` marks inside the span (empty: all NaN, JSON null). */
  intervalMs: Pct;
  /** `chart-draw` measures (end − start) ending inside the span. */
  drawMs: Pct;
  /** Intervals > 16.7 ms and > 33.4 ms (one and two missed frames). */
  over1: number;
  over2: number;
  /** Steps dispatched; `coalescing` = steps / frames (T03-020: the ring coalesces). */
  steps: number;
  coalescing: number;
  /** Hover events the frame emitted during a hover case. */
  hovers?: number;
  /** The case's time box ran out (not a failure). */
  timedOut?: true;
  skipped?: 'memory' | 'leg-unavailable';
}

/** The span the script ran in, ms on the page's clock: marks outside it are not counted. */
export interface Span {
  start: number;
  end: number;
}

/** What `drive` collected: page-clock times (ms) of the marks and measures. */
export interface Drive {
  presents: number[];
  draws: { start: number; end: number }[];
  span: Span;
  /** Steps dispatched. */
  steps: number;
  /** The box ran out before the script ended or before 2 presents. */
  timedOut: boolean;
}

/** Nearest rank on the sorted copy; empty → all NaN (written to JSON as null). */
export function percentiles(xs: readonly number[]): Pct {
  if (xs.length === 0) return { p50: NaN, p95: NaN, p99: NaN, max: NaN };
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number): number =>
    s[Math.min(s.length, Math.max(1, Math.ceil(p * s.length))) - 1] ?? NaN;
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: s[s.length - 1] ?? NaN };
}

/** One and two missed frames at 60 Hz. */
export const OVER_1_MS = 16.7;
export const OVER_2_MS = 33.4;

/**
 * One case's result: `frames` counts the `chart-present` marks inside the span, the intervals are
 * between consecutive ones, the draw times are the `chart-draw` measures that end inside it;
 * `steps` and `timedOut` are the drive's.
 */
export function summarise(
  c: Omit<
    BenchResult,
    'frames' | 'drawMs' | 'intervalMs' | 'over1' | 'over2' | 'coalescing' | 'steps' | 'timedOut'
  >,
  d: Drive,
): BenchResult {
  const inSpan = (t: number): boolean => t >= d.span.start && t <= d.span.end;
  const marks = d.presents.filter(inSpan).sort((a, b) => a - b);
  const intervals = marks.slice(1).map((t, i) => t - (marks[i] ?? t));
  const drawn = d.draws.filter((x) => inSpan(x.end)).map((x) => x.end - x.start);
  return {
    ...c,
    frames: marks.length,
    intervalMs: percentiles(intervals),
    drawMs: percentiles(drawn),
    over1: intervals.filter((x) => x > OVER_1_MS).length,
    over2: intervals.filter((x) => x > OVER_2_MS).length,
    steps: d.steps,
    coalescing: marks.length > 0 ? d.steps / marks.length : NaN,
    ...(d.timedOut ? { timedOut: true as const } : {}),
  };
}

/** A drive with nothing collected (a skipped or timed-out case). */
export function emptyDrive(timedOut = false): Drive {
  return { presents: [], draws: [], span: { start: 0, end: 0 }, steps: 0, timedOut };
}

/** PRF-001: p50 interval ≤ 16.7 ms; PRF-002: p99 ≤ 22.2 ms. */
export const PRF_001_MS = 16.7;
export const PRF_002_MS = 22.2;

export type BudgetStatus = 'ok' | 'over' | 'n/a';

/** PRF-001 and PRF-002 for a result: `n/a` when the percentile is empty (NaN or JSON null). */
export function budgets(r: Pick<BenchResult, 'intervalMs'>): {
  prf001: BudgetStatus;
  prf002: BudgetStatus;
} {
  // A JSON-read result has null for an empty percentile.
  const status = (v: number | null, limit: number): BudgetStatus =>
    v === null || !Number.isFinite(v) ? 'n/a' : v <= limit ? 'ok' : 'over';
  return {
    prf001: status(r.intervalMs.p50, PRF_001_MS),
    prf002: status(r.intervalMs.p99, PRF_002_MS),
  };
}

/** The clock `collectUntil` runs on (the page's in `drive`; a fake in the unit tests). */
export interface CollectClock {
  now(): number;
  wait(ms: number): Promise<void>;
}

/**
 * After the script: polls every `pollMs` until `presents()` reaches `min` or `boxMs` has passed
 * since `start`; whether the box ran out. Self-contained (`drive` runs its source in the page).
 */
export async function collectUntil(
  clock: CollectClock,
  presents: () => number,
  o: { start: number; boxMs: number; min: number; pollMs: number },
): Promise<boolean> {
  while (presents() < o.min) {
    if (clock.now() - o.start >= o.boxMs) return true;
    await clock.wait(o.pollMs);
  }
  return false;
}
