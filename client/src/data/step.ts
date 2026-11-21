/**
 * Mirror of the BFF's `PromGrid` (plan #62 A.3) for stub mode; the BFF's grid is authoritative.
 * Both are checked against `wire/fixtures/json/promql-step.json`.
 */
export interface Grid {
  readonly startMs: number;
  readonly endMs: number;
  readonly stepMs: number;
}

/** The step ladder in ms: 1 s … 1 d, the same 11 values as Go's `pulsusdb.Ladder`. */
export const LADDER_MS: readonly number[] = [
  1e3, 5e3, 10e3, 15e3, 30e3, 60e3, 300e3, 900e3, 3600e3, 21600e3, 86400e3,
];

/** The most steps a range grid has (`promGrid` is null past it). */
export const MAX_STEPS = 11000;

/**
 * The step is also the base of the rate window the Explore planner writes for a bare counter or
 * histogram selector (`rateWindowMs` in `explore/plan.ts`: at least 4 × step).
 *
 * The step is the first ladder entry with `entry × widthPx ≥ toMs − fromMs` (else 1 d); the
 * start is floored and the end raised to it. `null` when the range needs more than 11 000 steps.
 */
export function promGrid(fromMs: number, toMs: number, widthPx: number): Grid | null {
  const span = Math.max(toMs - fromMs, 0);
  const w = Math.max(widthPx, 1);
  const stepMs = LADDER_MS.find((e) => e * w >= span) ?? 86400e3;
  const startMs = Math.floor(fromMs / stepMs) * stepMs;
  const endMs = Math.ceil(toMs / stepMs) * stepMs;
  if ((endMs - startMs) / stepMs > MAX_STEPS) return null;
  return { startMs, endMs, stepMs };
}
