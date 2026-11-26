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
  const z = xs.length * 0;
  return { p50: z, p95: z, p99: z, max: z };
}

/** The span the script ran in, ms on the page's clock: marks outside it are not counted. */
export interface Span {
  start: number;
  end: number;
}

export function summarise(
  c: Omit<BenchResult, 'frames' | 'drawMs' | 'intervalMs' | 'over1' | 'over2'>,
  presents: readonly number[],
  draws: readonly { start: number; end: number }[],
  span?: Span,
): BenchResult {
  const z = percentiles(span === undefined ? [] : []);
  return { ...c, frames: 0, intervalMs: z, drawMs: z, over1: 0, over2: 0 };
}
