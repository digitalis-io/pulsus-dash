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

interface Layout {
  readonly timestamps: Float64Array;
  readonly bounds: Float64Array;
  /** Per series: the index of its bound in `bounds`. */
  readonly boundIndex: readonly number[];
  /** Per series: its group's name (labels without `le`). */
  readonly group: readonly string[];
}

/** The full view's axis, or `null` when the series are not a histogram (§4.2). */
function layout(series: readonly SeriesFrame[]): Layout | null {
  const first = series[0];
  if (first === undefined) return null;
  const own: number[] = [];
  for (const s of series) {
    const b = boundOf(s.labels['le']);
    if (b === null) return null;
    const same =
      s.timestamps.length === first.timestamps.length &&
      s.timestamps.every((t, i) => t === first.timestamps[i]);
    if (!same) return null;
    own.push(b);
  }
  const sorted = [...new Set(own)].sort((a, b) => a - b);
  if (!sorted.some((b) => Number.isFinite(b))) return null;
  const bounds = new Float64Array(sorted);
  return {
    timestamps: Float64Array.from(first.timestamps),
    bounds,
    boundIndex: own.map((b) => sorted.indexOf(b)),
    group: series.map((s) =>
      seriesName(Object.fromEntries(Object.entries(s.labels).filter(([k]) => k !== 'le'))),
    ),
  };
}

/**
 * Group `members`' count per cell (`c_g`, §4.2), row-major by time; NaN where the group lacks, or
 * misses a sample at, either bound of the interval. The lower bound of the first interval is 0.
 */
function groupCounts(
  series: readonly SeriesFrame[],
  members: readonly number[],
  l: Layout,
): Float64Array {
  const nt = l.timestamps.length;
  const nb = l.bounds.length;
  // cum[t·nb + b]: Σ over the group's series with bound b; NaN when none has it or one is missing.
  const cum = new Float64Array(nt * nb).fill(NaN);
  const has = new Uint8Array(nb);
  for (const i of members) {
    const b = l.boundIndex[i] ?? 0;
    const values = series[i]?.values;
    for (let t = 0; t < nt; t++) {
      const v = values?.[t] ?? NaN;
      const prev = has[b] === 1 ? (cum[t * nb + b] ?? NaN) : 0;
      cum[t * nb + b] = Number.isFinite(v) ? prev + v : NaN;
    }
    has[b] = 1;
  }
  const out = new Float64Array(nt * nb);
  for (let t = 0; t < nt; t++) {
    for (let b = 0; b < nb; b++) {
      const hi = cum[t * nb + b] ?? NaN;
      const lo = b === 0 ? 0 : (cum[t * nb + b - 1] ?? NaN);
      out[t * nb + b] = Number.isFinite(hi) && Number.isFinite(lo) ? Math.max(0, hi - lo) : NaN;
    }
  }
  return out;
}

/** The series indexes of each group, in order of first appearance. */
function groupsOf(l: Layout): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  l.group.forEach((g, i) => {
    const m = groups.get(g);
    if (m === undefined) groups.set(g, [i]);
    else m.push(i);
  });
  return groups;
}

/**
 * The bucket counts of `series` (§4.2): `null` unless every series has a valid `le`, all share
 * their timestamps and one bound is finite. Each cell is the sum over the groups' counts, NaN when
 * any group's count is missing. A frame whose cells are all NaN is still returned.
 */
export function histogramBuckets(series: readonly SeriesFrame[]): HeatmapFrame | null {
  const l = layout(series);
  if (l === null) return null;
  const counts = new Float64Array(l.timestamps.length * l.bounds.length);
  for (const members of groupsOf(l).values()) {
    const c = groupCounts(series, members, l);
    for (let k = 0; k < counts.length; k++) counts[k] = (counts[k] ?? 0) + (c[k] ?? NaN);
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
  const members = groupsOf(l).get(l.group[i] ?? '') ?? [i];
  const c = groupCounts(series, members, l);
  const nb = l.bounds.length;
  const row = l.boundIndex[i] ?? 0;
  const counts = new Float64Array(c.length).fill(NaN);
  for (let t = 0; t < l.timestamps.length; t++) counts[t * nb + row] = c[t * nb + row] ?? NaN;
  return { timestamps: l.timestamps, bounds: l.bounds, counts };
}
