/**
 * The interim 2D camera math (#93, T02 §4.6): zoom about an anchor, pan, and the limits a view
 * stays inside. Pure and f64; nothing is rounded except the whole-ms pan `step` and `toWindow`.
 */
import { MAX_WINDOW_MS, MIN_WINDOW_MS } from '../../state/contextReducer';
import type { PlotRect, TimeWindow } from '../api';

export interface Span {
  readonly lo: number;
  readonly hi: number;
}

export interface SpanLimits {
  readonly minSpan: number;
  readonly maxSpan: number;
  readonly lo: number;
  readonly hi: number;
}

/** The last representable instant of a window: 9999-12-31T23:59:59.999Z. */
const TIME_MAX = Date.UTC(9999, 11, 31, 23, 59, 59, 999);
const VALUE_MAX = 1e300;

/**
 * Time: minSpan = max(MIN_WINDOW_MS, ceil(plotWidth)) (≈ 1 ms per CSS px, so whole-ms rounding
 * moves the anchor < 0.51 px), maxSpan = MAX_WINDOW_MS, inside [0, 9999-12-31T23:59:59.999Z].
 */
export function timeLimits(plotWidth: number): SpanLimits {
  return {
    minSpan: Math.max(MIN_WINDOW_MS, Math.ceil(plotWidth)),
    maxSpan: MAX_WINDOW_MS,
    lo: 0,
    hi: TIME_MAX,
  };
}

/** Values: span ≥ 1e-9 · max(1, |anchor|), ≤ 1e300, inside ±1e300. */
export function valueLimits(anchor: number): SpanLimits {
  return {
    minSpan: 1e-9 * Math.max(1, Math.abs(anchor)),
    maxSpan: VALUE_MAX,
    lo: -VALUE_MAX,
    hi: VALUE_MAX,
  };
}

/** Shifts `s` (width kept, or clamped to the bounds' width) so that it lies inside the bounds. */
export function contain(s: Span, limits: SpanLimits): Span {
  const w = Math.min(s.hi - s.lo, limits.hi - limits.lo);
  if (s.lo < limits.lo) return { lo: limits.lo, hi: limits.lo + w };
  if (s.hi > limits.hi) return { lo: limits.hi - w, hi: limits.hi };
  if (w !== s.hi - s.lo) return { lo: s.lo, hi: s.lo + w };
  return s;
}

/**
 * Zooms `s` by `factor` (> 1 out, < 1 in) about the value at fraction `f` (0 = lo, 1 = hi), which
 * stays at `f`. A zoom-in never widens a window already below `minSpan`; a zoom-out from one goes
 * to at least `minSpan`. An unchanged width returns `s` itself (no recomputed ends).
 */
export function zoomAbout(s: Span, f: number, factor: number, limits: SpanLimits): Span {
  const w = s.hi - s.lo;
  const floor = factor < 1 ? Math.min(w, limits.minSpan) : limits.minSpan;
  const w2 = Math.min(Math.max(w * factor, floor), limits.maxSpan);
  if (w2 === w) return s;
  const a = s.lo + f * w;
  const lo = a - f * w2;
  return contain({ lo, hi: lo + w2 }, limits);
}

/**
 * Shifts `s` by d = fraction · (hi − lo) (positive → higher values), then `contain`. With
 * `step > 0`, d is rounded to a whole number of steps (time pans of a sub-minimum view pass 1).
 */
export function panBy(s: Span, fraction: number, limits: SpanLimits, step = 0): Span {
  let d = fraction * (s.hi - s.lo);
  if (step > 0) d = Math.round(d / step) * step;
  if (d === 0) return s;
  return contain({ lo: s.lo + d, hi: s.hi + d }, limits);
}

/** Fraction of `plot` along x for CSS px `x` (unclamped). */
export const fx = (plot: PlotRect, x: number): number => (x - plot.x) / plot.width;

/** Fraction from the bottom of `plot` for CSS px `y`: 0 at the bottom edge, 1 at the top. */
export const fy = (plot: PlotRect, y: number): number => 1 - (y - plot.y) / plot.height;

/** Whole-ms window of a time span (`Math.round` both ends; `toMs ≥ fromMs + 1`). */
export function toWindow(s: Span): TimeWindow {
  const fromMs = Math.round(s.lo);
  return { fromMs, toMs: Math.max(fromMs + 1, Math.round(s.hi)) };
}
