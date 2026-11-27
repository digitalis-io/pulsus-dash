/**
 * The frame benches' statistics (plan #68 C2d1 §3.1; T05 §4.3 `bench:frame-gallery`,
 * `bench:frame-line-1e8`): percentiles by nearest rank and one case's `BenchResult` from its
 * `chart-present` marks and `chart-draw` measures. Pure: `e2e/bench/frameBench.ts` collects the
 * times in the page and writes the results.
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
  /** Between consecutive `chart-present` marks inside the span. */
  intervalMs: Pct;
  /** `chart-draw` measures (end − start) inside the span. */
  drawMs: Pct;
  /** Intervals > 16.7 ms and > 33.4 ms (one and two missed frames). */
  over1: number;
  over2: number;
  skipped?: 'memory' | 'leg-unavailable';
}

/** Nearest rank on the sorted copy; empty → all NaN. */
export function percentiles(xs: readonly number[]): Pct {
  if (xs.length === 0) return { p50: NaN, p95: NaN, p99: NaN, max: NaN };
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number): number =>
    s[Math.min(s.length, Math.max(1, Math.ceil(p * s.length))) - 1] ?? NaN;
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: s[s.length - 1] ?? NaN };
}

/** The span the script ran in, ms on the page's clock: marks outside it are not counted. */
export interface Span {
  start: number;
  end: number;
}

/** One and two missed frames at 60 Hz. */
export const OVER_1_MS = 16.7;
export const OVER_2_MS = 33.4;

/**
 * One case's result: `frames` counts the `chart-present` marks inside `span` (all, without one),
 * the intervals are between consecutive ones, the draw times are the `chart-draw` measures that
 * end inside it.
 */
export function summarise(
  c: Omit<BenchResult, 'frames' | 'drawMs' | 'intervalMs' | 'over1' | 'over2'>,
  presents: readonly number[],
  draws: readonly { start: number; end: number }[],
  span?: Span,
): BenchResult {
  const inSpan = (t: number): boolean => span === undefined || (t >= span.start && t <= span.end);
  const marks = presents.filter(inSpan).sort((a, b) => a - b);
  const intervals = marks.slice(1).map((t, i) => t - (marks[i] ?? t));
  const drawn = draws.filter((d) => inSpan(d.end)).map((d) => d.end - d.start);
  return {
    ...c,
    frames: marks.length,
    intervalMs: percentiles(intervals),
    drawMs: percentiles(drawn),
    over1: intervals.filter((x) => x > OVER_1_MS).length,
    over2: intervals.filter((x) => x > OVER_2_MS).length,
  };
}
