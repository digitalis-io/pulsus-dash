/**
 * The one-point-per-CSS-px reduction (ADR-0014 §4). A series becomes one column per CSS px of the
 * plot, keeping the finite min, max and last of each column (with their timestamps), the NaN-free
 * runs inside it, and whether a gap precedes its last sample; bucketed data is merged to at most
 * one bucket per CSS px. Work is linear in the input.
 */
import type { PlotRect, TimeWindow } from '../api';

export interface Run {
  readonly min: number;
  readonly max: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly count: number;
}

export interface Column {
  /** Column index 0..width−1. */
  readonly x: number;
  readonly min: number;
  readonly max: number;
  readonly last: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly lastMs: number;
  /** Finite samples in the column. */
  readonly count: number;
  /** Maximal NaN-free runs in the column, in time order (≥ 1). */
  readonly runs: readonly Run[];
  /** A NaN lies after the previous finite sample (any column) and before `last`. */
  readonly breakBefore: boolean;
}

interface MutableRun {
  min: number;
  max: number;
  minMs: number;
  maxMs: number;
  count: number;
}

interface MutableColumn extends MutableRun {
  x: number;
  last: number;
  lastMs: number;
  runs: MutableRun[];
  breakBefore: boolean;
}

/** The plot's whole CSS px columns. */
export function columnCount(plot: PlotRect): number {
  return Math.max(0, Math.floor(plot.width));
}

function columnOf(t: number, w: TimeWindow, n: number): number {
  const x = Math.floor(((t - w.fromMs) / (w.toMs - w.fromMs)) * n);
  return Math.min(n - 1, Math.max(0, x));
}

export function lineColumns(
  ts: Float64Array,
  vs: Float64Array,
  w: TimeWindow,
  plot: PlotRect,
): (Column | null)[] {
  const n = columnCount(plot);
  const out: (MutableColumn | null)[] = Array.from({ length: n }, () => null);
  if (n === 0 || !(w.toMs > w.fromMs)) return out;
  // A NaN seen since the last finite sample, and whether the current run is open.
  let gap = false;
  let current: MutableColumn | null = null;
  let run: MutableRun | null = null;
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i] ?? NaN;
    if (!(t >= w.fromMs && t <= w.toMs)) continue;
    const v = vs[i] ?? NaN;
    if (!Number.isFinite(v)) {
      gap = true;
      run = null;
      continue;
    }
    const x = columnOf(t, w, n);
    if (current === null || current.x !== x) {
      run = { min: v, max: v, minMs: t, maxMs: t, count: 1 };
      current = {
        x,
        min: v,
        max: v,
        minMs: t,
        maxMs: t,
        count: 1,
        last: v,
        lastMs: t,
        runs: [run],
        breakBefore: gap,
      };
      out[x] = current;
      gap = false;
      continue;
    }
    if (v < current.min) {
      current.min = v;
      current.minMs = t;
    }
    if (v > current.max) {
      current.max = v;
      current.maxMs = t;
    }
    current.last = v;
    current.lastMs = t;
    current.count += 1;
    if (gap) current.breakBefore = true;
    gap = false;
    if (run === null) {
      run = { min: v, max: v, minMs: t, maxMs: t, count: 1 };
      current.runs.push(run);
    } else {
      if (v < run.min) {
        run.min = v;
        run.minMs = t;
      }
      if (v > run.max) {
        run.max = v;
        run.maxMs = t;
      }
      run.count += 1;
    }
  }
  return out;
}

/**
 * The end of bucket `i`: the next bucket's start; for the last bucket its start plus the previous
 * step (the frame's step), or `fallbackEnd` when there is only one bucket.
 */
export function bucketEnd(ts: Float64Array, i: number, fallbackEnd: number): number {
  const t = ts[i] ?? NaN;
  if (i + 1 < ts.length) return ts[i + 1] ?? t;
  return ts.length > 1 ? t + (t - (ts[i - 1] ?? t)) : fallbackEnd;
}

/**
 * Buckets merged to at most one per CSS px column, `stride` counts per bucket summed (non-finite
 * counts as 0). A bucket is kept when its interval [start, end) overlaps the window, and is placed
 * at its start clipped to the window, so a bucket that begins before `from` still covers the left
 * edge; buckets wholly outside the window are dropped, never merged into the edge columns. A group
 * starts at its first (clipped) bucket; `endMs` is the clipped end of the last kept bucket. Used
 * when there are more buckets than CSS px.
 */
export type MergeMissing = 'zero' | 'missing';

export function mergeBuckets(
  ts: Float64Array,
  counts: Float64Array,
  stride: number,
  w: TimeWindow,
  plot: PlotRect,
  _missing: MergeMissing = 'zero',
): { ts: Float64Array; counts: Float64Array; endMs: number } {
  const n = columnCount(plot);
  const starts: number[] = [];
  const sums: number[] = [];
  let lastX = -1;
  let endMs = w.toMs;
  for (let i = 0; i < ts.length; i++) {
    const start = ts[i] ?? NaN;
    const end = bucketEnd(ts, i, w.toMs);
    if (!(start < w.toMs && end > w.fromMs)) continue;
    const t = Math.max(start, w.fromMs);
    endMs = Math.min(end, w.toMs);
    const x = n === 0 ? 0 : columnOf(t, w, n);
    if (x !== lastX || starts.length === 0) {
      starts.push(t);
      for (let b = 0; b < stride; b++) sums.push(0);
      lastX = x;
    }
    const base = (starts.length - 1) * stride;
    for (let b = 0; b < stride; b++) {
      const c = counts[i * stride + b] ?? 0;
      if (Number.isFinite(c)) sums[base + b] = (sums[base + b] ?? 0) + c;
    }
  }
  return { ts: new Float64Array(starts), counts: new Float64Array(sums), endMs };
}

const SNAP_UNITS_MS: readonly number[] = [
  1_000, 5_000, 10_000, 15_000, 30_000, 60_000, 300_000, 900_000, 1_800_000, 3_600_000, 86_400_000,
];

/** The brush snap unit: the smallest of 1 s … 1 d that is at least 4 CSS px of time (§4.3). */
export function brushSnapUnit(msPerPx: number): number {
  return SNAP_UNITS_MS.find((u) => u >= 4 * msPerPx) ?? 86_400_000;
}
