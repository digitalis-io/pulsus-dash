/**
 * Mirrors of the BFF's grids for stub mode; the BFF's grid is authoritative. `promGrid` is Go's
 * `PromGrid` (#62, #303), checked against `wire/fixtures/json/promql-step.json`; `logGrid` is
 * Go's `LogGrid`, checked against `wire/fixtures/json/log-step.json`.
 */
export interface Grid {
  readonly startMs: number;
  readonly endMs: number;
  readonly stepMs: number;
}

/** The PromQL step ladder in ms (#303): 15 s (the scrape interval) … 1 d, Go's `pulsusdb.PromLadder`. */
export const PROM_LADDER_MS: readonly number[] = [
  15e3, 30e3, 60e3, 120e3, 300e3, 600e3, 720e3, 900e3, 1800e3, 3600e3, 7200e3, 10800e3, 21600e3,
  43200e3, 86400e3,
];

/** The log routes' step ladder in ms: 1 s … 1 d, the same 11 values as Go's `pulsusdb.Ladder`. */
export const LOG_LADDER_MS: readonly number[] = [
  1e3, 5e3, 10e3, 15e3, 30e3, 60e3, 300e3, 900e3, 3600e3, 21600e3, 86400e3,
];

/** The most steps a range grid has (`promGrid` and `logGrid` are null past it). */
export const MAX_STEPS = 11000;

function align(fromMs: number, toMs: number, stepMs: number): Grid {
  return {
    startMs: Math.floor(fromMs / stepMs) * stepMs,
    endMs: Math.ceil(toMs / stepMs) * stepMs,
    stepMs,
  };
}

/**
 * The PromQL grid (#303): about one point per CSS pixel. The step is the ladder entry nearest to
 * `(toMs − fromMs) / widthPx`, the larger of two neighbours from their midpoint up
 * (`2 × span ≥ (lo + hi) × width`), at least 15 s, and raised to the next entry while the grid
 * would have more than 11 000 steps. The step is also the base of the rate window
 * (`rateWindowMs`, `max(step + 15 s, 60 s)`). `null` when 1 d still gives more than 11 000 steps.
 */
export function promGrid(fromMs: number, toMs: number, widthPx: number): Grid | null {
  const span = Math.max(toMs - fromMs, 0);
  const w = Math.max(widthPx, 1);
  const L = PROM_LADDER_MS;
  let i = 0;
  while (i + 1 < L.length && 2 * span >= ((L[i] ?? 0) + (L[i + 1] ?? 0)) * w) i++;
  for (; i < L.length; i++) {
    const g = align(fromMs, toMs, L[i] ?? 86400e3);
    if ((g.endMs - g.startMs) / g.stepMs <= MAX_STEPS) return g;
  }
  return null;
}

/**
 * The log routes' grid (#62, unchanged by #303): the step is the first ladder entry with
 * `entry × widthPx ≥ toMs − fromMs` (else 1 d); the start is floored and the end raised to it.
 * `null` when the range needs more than 11 000 steps.
 */
export function logGrid(fromMs: number, toMs: number, widthPx: number): Grid | null {
  const span = Math.max(toMs - fromMs, 0);
  const w = Math.max(widthPx, 1);
  const g = align(fromMs, toMs, LOG_LADDER_MS.find((e) => e * w >= span) ?? 86400e3);
  return (g.endMs - g.startMs) / g.stepMs > MAX_STEPS ? null : g;
}
