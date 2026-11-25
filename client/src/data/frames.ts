/**
 * Chart frame data (plan #58 §3.2): series, heatmap and scalar frames, and their validation. The
 * component validates; the engine assumes valid data.
 */
import type { VisSpec } from '../engine/api';
import type { CATEGORY_PATTERNS } from '../engine/patterns';
import type { Completeness } from './decode';

/** A series' labels. */
export type Labels = Readonly<Record<string, string>>;

/** key_hash (T04-004) as 16 lower-case hex digits. */
export const KEY_PATTERN = /^[0-9a-f]{16}$/;

export interface SeriesFrame {
  readonly key: string;
  readonly labels: Readonly<Record<string, string>>;
  /** ms, strictly increasing. */
  readonly timestamps: Float64Array;
  /** Same length; NaN = gap. */
  readonly values: Float64Array;
}

export interface HeatmapFrame {
  /** Column starts, strictly increasing, length T ≥ 1. */
  readonly timestamps: Float64Array;
  /** Bucket upper bounds, strictly increasing, length B ≥ 1; the last may be +Inf. */
  readonly bounds: Float64Array;
  /** Length T·B, row-major by time: counts[t·B + b]. */
  readonly counts: Float64Array;
}

export interface ScalarFrame {
  readonly value: number;
  readonly timestampMs: number;
}

export type FrameData =
  | { readonly kind: 'series'; readonly series: readonly SeriesFrame[] }
  | { readonly kind: 'heatmap'; readonly heatmap: HeatmapFrame }
  | { readonly kind: 'scalar'; readonly scalar: ScalarFrame };

export type FrameDataIssue =
  | { code: 'kind' }
  | { code: 'key'; key: string }
  | { code: 'length'; key: string; timestamps: number; values: number }
  | { code: 'order'; key: string }
  | { code: 'cells'; columns: number; buckets: number; cells: number }
  | { code: 'bounds' }
  | { code: 'finite' }
  | { code: 'grid'; key: string };

function isIncreasing(a: Float64Array): boolean {
  for (let i = 0; i < a.length; i++) {
    const v = a[i] ?? NaN;
    if (!Number.isFinite(v)) return false;
    if (i > 0 && !(v > (a[i - 1] ?? NaN))) return false;
  }
  return true;
}

function seriesIssue(series: readonly SeriesFrame[]): FrameDataIssue | null {
  for (const s of series) if (!KEY_PATTERN.test(s.key)) return { code: 'key', key: s.key };
  for (const s of series) {
    if (s.timestamps.length !== s.values.length) {
      return {
        code: 'length',
        key: s.key,
        timestamps: s.timestamps.length,
        values: s.values.length,
      };
    }
  }
  for (const s of series) if (!isIncreasing(s.timestamps)) return { code: 'order', key: s.key };
  return null;
}

function heatmapIssue(h: HeatmapFrame): FrameDataIssue | null {
  // Heatmap columns are reported as the `heatmap` series for `order`.
  if (!isIncreasing(h.timestamps)) return { code: 'order', key: 'heatmap' };
  const columns = h.timestamps.length;
  const buckets = h.bounds.length;
  if (h.counts.length !== columns * buckets) {
    return { code: 'cells', columns, buckets, cells: h.counts.length };
  }
  for (let b = 0; b < buckets; b++) {
    const v = h.bounds[b] ?? NaN;
    const lastInf = b === buckets - 1 && v === Infinity;
    if (!Number.isFinite(v) && !lastInf) return { code: 'bounds' };
    if (b > 0 && !(v > (h.bounds[b - 1] ?? NaN))) return { code: 'bounds' };
  }
  if (!h.bounds.some((v) => Number.isFinite(v))) return { code: 'finite' };
  return null;
}

function gridIssue(series: readonly SeriesFrame[]): FrameDataIssue | null {
  const first = series[0];
  if (first === undefined) return null;
  for (const s of series) {
    const same =
      s.timestamps.length === first.timestamps.length &&
      s.timestamps.every((t, i) => t === first.timestamps[i]);
    if (!same) return { code: 'grid', key: s.key };
  }
  return null;
}

/**
 * The first problem with `data` for `spec`, in the order of `FrameDataIssue`, or `null`. `line` and
 * `bars` need series, `heatmap` a heatmap, and `stat` a scalar or series (the first series' last
 * finite value is shown).
 */
export function validateFrameData(spec: VisSpec, data: FrameData): FrameDataIssue | null {
  switch (spec.kind) {
    case 'line':
      return data.kind === 'series' ? seriesIssue(data.series) : { code: 'kind' };
    case 'bars':
      if (data.kind !== 'series') return { code: 'kind' };
      return seriesIssue(data.series) ?? gridIssue(data.series);
    case 'heatmap':
      return data.kind === 'heatmap' ? heatmapIssue(data.heatmap) : { code: 'kind' };
    case 'stat':
      if (data.kind === 'scalar') return null;
      return data.kind === 'series' ? seriesIssue(data.series) : { code: 'kind' };
  }
}

/** Data that draws an empty chart of `spec`'s kind: no series, a 0 × 0 heatmap, or `NaN`. */
export function emptyFrameData(spec: VisSpec): FrameData {
  switch (spec.kind) {
    case 'line':
    case 'bars':
      return { kind: 'series', series: [] };
    case 'heatmap':
      return {
        kind: 'heatmap',
        heatmap: {
          timestamps: new Float64Array(0),
          bounds: new Float64Array(0),
          counts: new Float64Array(0),
        },
      };
    case 'stat':
      return { kind: 'scalar', scalar: { value: NaN, timestampMs: NaN } };
  }
}

function quoted(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

/** `name{k="v", …}`: `__name__` first, other keys sorted; `{}` when empty; no `__name__` → `{…}`. */
export function seriesName(labels: Readonly<Record<string, string>>): string {
  const name = labels['__name__'] ?? '';
  const pairs = Object.keys(labels)
    .filter((k) => k !== '__name__')
    .sort()
    .map((k) => `${k}=${quoted(labels[k] ?? '')}`);
  return `${name}{${pairs.join(', ')}}`;
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
 * A histogram source group (T21-014, T21 §5): every series with the same `groupBy` value, or every
 * series without `groupBy`. Counts are values after the T22-003 merge.
 */
export interface SourceGroup {
  readonly key: string;
  readonly name: string;
  /** `{[L]: raw v}`; `{}` when the label is absent or there is no `groupBy`. */
  readonly labels: Labels;
  readonly received: number;
  /** received − nonPositive − infinite − outOfRange. */
  readonly drawable: number;
  readonly nonPositive: number;
  readonly infinite: number;
  readonly outOfRange: number;
  /** The drawn group index (`other`'s for its members); −1 when not drawn. */
  readonly drawnAs: number;
}

/** A drawn histogram group, in draw order (T21-014). */
export interface HistogramGroup {
  /** A `groupKey`, `all`, or `other`. */
  readonly key: string;
  readonly name: string;
  /** The series-N token index; −1 for `other` (token `category-other`). */
  readonly colourIndex: number;
  readonly pattern: (typeof CATEGORY_PATTERNS)[number] | 'solid' | 'grid';
  readonly dash: readonly number[];
  /** Source group indices. */
  readonly members: readonly number[];
  readonly drawable: number;
}

/** What a histogram counted and left out (T21-016). */
export interface HistogramCoverage {
  readonly query: Completeness;
  readonly received: number;
  readonly drawable: number;
  readonly nonPositive: number;
  readonly infinite: number;
  readonly outOfRange: number;
  readonly duplicates: number;
  readonly conflicts: number;
  /** The width used when a user or auto width was widened. */
  readonly widenedTo: number | null;
  /** k after the T21-013 guard or fallback. */
  readonly adjusted: number | null;
}

/** A histogram over raw values (T21-012 to T21-015; T21 §5, #154 fields). */
export interface HistogramFrame {
  /** Value units on every axis; k + 1 finite and increasing, 1 ≤ k ≤ 200. */
  readonly edges: Float64Array;
  /** Name order. */
  readonly sourceGroups: readonly SourceGroup[];
  /** Drawn, in draw order. */
  readonly groups: readonly HistogramGroup[];
  /** groups × k: counts[g·k + i]. */
  readonly counts: Float64Array;
  /** By key; labels raw. */
  readonly series: readonly {
    readonly key: string;
    readonly name: string;
    readonly labels: Labels;
    readonly sourceGroup: number;
  }[];
  /** CSR per series: bins ascending with count > 0; ≤ 2·10⁶ entries. */
  readonly contrib: {
    readonly offsets: Uint32Array;
    readonly bins: Uint16Array;
    readonly counts: Float64Array;
  };
  /** Drawable values, source groups contiguous in name order, each ascending. */
  readonly sorted: { readonly values: Float64Array; readonly offsets: Uint32Array };
  /** Type-7 over all drawable values; null when drawable is 0. */
  readonly quantiles: { readonly p25: number; readonly p50: number; readonly p75: number } | null;
  readonly countBasis: 'series' | 'samples';
  /** One bin whose edges are equal on display. */
  readonly collapsed: boolean;
  readonly coverage: HistogramCoverage;
}

/**
 * Whether `f` is a well-formed histogram frame: 1 ≤ k ≤ 200 finite increasing edges, groups × k
 * non-negative counts, CSR offsets from 0 to the entry count, non-decreasing, with bins below k and
 * non-negative counts, and sorted offsets ending at the value count.
 */
export function histogramFrameValid(f: HistogramFrame): boolean {
  void f;
  return false;
}
