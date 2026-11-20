/** The `a11y` summary of a drawn frame (plan #58 §3.8): per-kind min, max and last. */
import type {
  FrameData,
  FrameSummary,
  HeatmapFrame,
  PlotRect,
  SeriesFrame,
  TimeWindow,
  VisKind,
} from '../api';

export interface Stats {
  readonly min: number | null;
  readonly max: number | null;
  readonly last: number | null;
}

const NONE: Stats = { min: null, max: null, last: null };

/** Line: min and max over every finite shown value; last = the highest last finite value. */
export function lineStats(series: readonly SeriesFrame[]): Stats {
  let min = Infinity;
  let max = -Infinity;
  let last = -Infinity;
  for (const s of series) {
    let lastOf = NaN;
    for (const v of s.values) {
      if (!Number.isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
      lastOf = v;
    }
    if (Number.isFinite(lastOf) && lastOf > last) last = lastOf;
  }
  return min === Infinity ? NONE : { min, max, last: last === -Infinity ? null : last };
}

/** Per-bucket stacked totals of series on one time grid (non-finite values count as 0). */
export function stackedTotals(series: readonly SeriesFrame[]): Float64Array {
  const n = series[0]?.values.length ?? 0;
  const totals = new Float64Array(n);
  for (const s of series) {
    for (let i = 0; i < n; i++) {
      const v = s.values[i] ?? NaN;
      if (Number.isFinite(v)) totals[i] = (totals[i] ?? 0) + v;
    }
  }
  return totals;
}

/**
 * The finite minimum and maximum of `values`, in one pass (no spread into `Math.min`/`Math.max`,
 * which throws past the engine's argument limit); `null` when there is no finite value.
 */
export function extent(values: ArrayLike<number>): { min: number; max: number } | null {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i] ?? NaN;
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return min === Infinity ? null : { min, max };
}

/** Bars: min and max over the stacked totals; last = the last bucket's total. */
export function barStats(series: readonly SeriesFrame[]): Stats {
  const totals = stackedTotals(series);
  const e = extent(totals);
  if (e === null) return NONE;
  return { min: e.min, max: e.max, last: totals.at(-1) ?? null };
}

/** Heatmap: min and max over every cell count (zeros included); last = the last column's total. */
export function heatmapStats(h: HeatmapFrame): Stats {
  const b = h.bounds.length;
  const t = h.timestamps.length;
  if (b === 0 || t === 0) return NONE;
  let min = Infinity;
  let max = -Infinity;
  let last = 0;
  for (let i = 0; i < h.counts.length; i++) {
    const c = h.counts[i] ?? NaN;
    if (!Number.isFinite(c)) continue;
    if (c < min) min = c;
    if (c > max) max = c;
    if (i >= (t - 1) * b) last += c;
  }
  return min === Infinity ? NONE : { min, max, last };
}

/** The value a stat shows: the scalar, or the last finite value of the first series. */
export function statValue(data: FrameData): number {
  if (data.kind === 'scalar') return data.scalar.value;
  if (data.kind !== 'series') return NaN;
  const vs = data.series[0]?.values ?? new Float64Array(0);
  for (let i = vs.length - 1; i >= 0; i--) {
    const v = vs[i] ?? NaN;
    if (Number.isFinite(v)) return v;
  }
  return NaN;
}

export function frameSummary(
  kind: VisKind,
  w: TimeWindow,
  plot: PlotRect,
  total: number,
  shown: number,
  stats: Stats,
): FrameSummary {
  return {
    kind,
    seriesTotal: total,
    seriesShown: shown,
    fromMs: w.fromMs,
    toMs: w.toMs,
    min: stats.min,
    max: stats.max,
    last: stats.last,
    plot,
  };
}
