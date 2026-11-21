/**
 * Prometheus histogram buckets as heatmap counts (plan #63 §4.2, §4.3; VIZ-065 row 5). Each group
 * (the series with the same labels without `le`) gives its own count per interval, from its own
 * cumulative series; the groups' counts are summed per cell. A cell is missing (NaN) when any group
 * lacks, or misses a sample at, either bound of the interval: counts are never invented from a
 * missing sample or from cumulative values of different groups (T02 §4.4 gaps rule).
 */
import { seriesName, type HeatmapFrame, type SeriesFrame } from '../data/frames';

/** `+Inf`, `Inf` or a finite number; `null` otherwise. */
function boundOf(le: string | undefined): number | null {
  if (le === undefined) return null;
  if (le === '+Inf' || le === 'Inf') return Infinity;
  const n = Number(le);
  return Number.isFinite(n) ? n : null;
}

/** Whether every series has a valid `le` and the first series' timestamps. */
function onOneGrid(series: readonly SeriesFrame[]): boolean {
  const first = series[0];
  if (first === undefined) return false;
  const ts = first.timestamps;
  for (const s of series) {
    if (boundOf(s.labels['le']) === null) return false;
    if (s.timestamps === ts) continue;
    if (s.timestamps.length !== ts.length) return false;
    for (let i = 0; i < ts.length; i++) if (s.timestamps[i] !== ts[i]) return false;
  }
  return true;
}

/**
 * Whether `series` are a histogram (§4.2): every series has a valid `le`, all share their
 * timestamps and one bound is finite. `histogramBuckets(series) !== null` iff this is true; it
 * does not convert, so auto-vis and isolation can ask it cheaply.
 */
export function isHistogram(series: readonly SeriesFrame[]): boolean {
  return onOneGrid(series) && series.some((s) => Number.isFinite(boundOf(s.labels['le'])));
}

/** One group's series of one bound. */
interface Level {
  /** The index of the bound in the full view's `bounds`. */
  readonly bound: number;
  readonly members: readonly number[];
}

interface Layout {
  readonly timestamps: Float64Array;
  readonly bounds: Float64Array;
  /** Per series: the index of its bound in `bounds`. */
  readonly boundIndex: Int32Array;
  /** Per series: the index of its group in `groups`. */
  readonly groupOf: Int32Array;
  /** Per group (labels without `le`, in order of first appearance): its levels by bound. */
  readonly groups: readonly (readonly Level[])[];
}

/** The full view's axis and groups, or `null` when the series are not a histogram (§4.2). */
function layout(series: readonly SeriesFrame[]): Layout | null {
  const first = series[0];
  if (first === undefined || !isHistogram(series)) return null;
  const own = series.map((s) => boundOf(s.labels['le']) ?? NaN);
  const sorted = [...new Set(own)].sort((a, b) => a - b);
  const index = new Map(sorted.map((b, i) => [b, i]));
  const boundIndex = Int32Array.from(own, (b) => index.get(b) ?? 0);
  const names = new Map<string, number>();
  const byGroup: Map<number, number[]>[] = [];
  const groupOf = new Int32Array(series.length);
  series.forEach((s, i) => {
    const name = seriesName(
      Object.fromEntries(Object.entries(s.labels).filter(([k]) => k !== 'le')),
    );
    let g = names.get(name);
    if (g === undefined) {
      g = byGroup.length;
      names.set(name, g);
      byGroup.push(new Map());
    }
    groupOf[i] = g;
    const levels = byGroup[g];
    const b = boundIndex[i] ?? 0;
    const m = levels?.get(b);
    if (m === undefined) levels?.set(b, [i]);
    else m.push(i);
  });
  return {
    timestamps: Float64Array.from(first.timestamps),
    bounds: new Float64Array(sorted),
    boundIndex,
    groupOf,
    groups: byGroup.map((levels) =>
      [...levels].sort(([a], [b]) => a - b).map(([bound, members]) => ({ bound, members })),
    ),
  };
}

/**
 * A group's cumulative value of one bound at time `t`: the sum over its series of that bound; NaN
 * when one of them misses the sample (T02 §4.4).
 */
function cumulative(series: readonly SeriesFrame[], level: Level, t: number): number {
  let sum = 0;
  for (const i of level.members) {
    const v = series[i]?.values[t] ?? NaN;
    sum = Number.isFinite(v) ? sum + v : NaN;
  }
  return sum;
}

/** A group's count `c_g` of one interval: NaN when either cumulative value is missing (§4.2). */
function count(hi: number, lo: number): number {
  return Number.isFinite(hi) && Number.isFinite(lo) ? Math.max(0, hi - lo) : NaN;
}

/**
 * The bucket counts of `series` (§4.2): `null` unless `isHistogram(series)`. Each cell is the sum
 * over the groups' counts, NaN when any group's count is missing: a group lacking a bound makes
 * that interval and the next missing for every timestamp, and a missing sample makes the cell's
 * group count missing. The lower bound of the first interval is 0. A frame whose cells are all NaN
 * is still returned. Work is linear in the input and the output: each group visits only its own
 * bounds.
 */
export function histogramBuckets(series: readonly SeriesFrame[]): HeatmapFrame | null {
  const l = layout(series);
  if (l === null) return null;
  const nt = l.timestamps.length;
  const nb = l.bounds.length;
  // missing[b]: some group lacks bound b, so its count of intervals b and b + 1 is missing.
  const present = new Uint32Array(nb);
  for (const levels of l.groups)
    for (const { bound } of levels) present[bound] = (present[bound] ?? 0) + 1;
  const missing = (b: number) => b >= 0 && (present[b] ?? 0) < l.groups.length;
  const counts = new Float64Array(nt * nb);
  for (const levels of l.groups) {
    for (let t = 0; t < nt; t++) {
      let lo = 0;
      let loBound = -1;
      for (const level of levels) {
        const hi = cumulative(series, level, t);
        const b = level.bound;
        if (loBound === b - 1 && !missing(b) && !missing(b - 1)) {
          const k = t * nb + b;
          counts[k] = (counts[k] ?? NaN) + count(hi, lo);
        }
        lo = hi;
        loBound = b;
      }
    }
  }
  for (let b = 0; b < nb; b++) {
    if (!missing(b) && !missing(b - 1)) continue;
    for (let t = 0; t < nt; t++) counts[t * nb + b] = NaN;
  }
  return { timestamps: l.timestamps, bounds: l.bounds, counts };
}

/**
 * The full view's axis with only `key`'s row filled: its group's term of the full view's sum for
 * that row (§4.3), NaN when that term is missing; every other cell NaN. `key` absent →
 * `histogramBuckets(series)`; `null` iff that is `null`.
 */
export function isolateBucket(series: readonly SeriesFrame[], key: string): HeatmapFrame | null {
  const i = series.findIndex((s) => s.key === key);
  if (i < 0) return histogramBuckets(series);
  const l = layout(series);
  if (l === null) return null;
  const levels = l.groups[l.groupOf[i] ?? 0] ?? [];
  const row = l.boundIndex[i] ?? 0;
  const hiLevel = levels.find((v) => v.bound === row);
  const loLevel = row === 0 ? undefined : levels.find((v) => v.bound === row - 1);
  const nt = l.timestamps.length;
  const nb = l.bounds.length;
  const counts = new Float64Array(nt * nb).fill(NaN);
  if (hiLevel === undefined || (row > 0 && loLevel === undefined)) {
    return { timestamps: l.timestamps, bounds: l.bounds, counts };
  }
  for (let t = 0; t < nt; t++) {
    const lo = loLevel === undefined ? 0 : cumulative(series, loLevel, t);
    counts[t * nb + row] = count(cumulative(series, hiLevel, t), lo);
  }
  return { timestamps: l.timestamps, bounds: l.bounds, counts };
}
