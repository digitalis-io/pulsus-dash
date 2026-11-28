/**
 * Chart frame data (plan #58 §3.2): series, heatmap and scalar frames, and their validation. The
 * component validates; the engine assumes valid data.
 */
import type { ThresholdState, TimeWindow, VisSpec } from '../engine/api';
import type { CATEGORY_PATTERNS } from '../engine/patterns';
import type { GeoFrame } from '../vis/geo/frame';
import type { Basemap } from '../vis/geo/types';
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

/**
 * A mark's state: `theme/stateEncoding`'s `State`, spelled out here so that this module needs no
 * CSS module (the e2e suite imports it).
 */
export type State = 'ok' | ThresholdState | 'unknown';

/** A categorical reducer (T22 §6.1 `options.reducer`). */
export type Reducer = 'last' | 'first' | 'mean' | 'min' | 'max' | 'sum' | 'count';

/**
 * One reduced series (T22 §5.1): its source series key, labels, display name (T22-004), reduced
 * value, threshold state, the baseline run's value for the same key, and the anomaly score (null
 * until Epic #9).
 */
export interface Mark {
  readonly key: string;
  readonly labels: Labels;
  readonly name: string;
  readonly value: number;
  readonly state: State | null;
  readonly baseline: number | null;
  readonly anomaly: number | null;
}

/** A member of an aggregate row (`other (n)`, I3). */
export interface CategoryMember {
  readonly key: string;
  readonly labels: Labels;
  readonly name: string;
  readonly value: number;
}

/** A bar or wedge; `members` is non-null only on the `other (n)` aggregate (I3). */
export interface CategoryRow extends Mark {
  readonly members: readonly CategoryMember[] | null;
}

/**
 * What a categorical frame drew of its rows (T22-006, VIZ-027): the pre-cap total and the drawn
 * count, what the cap kept, values outside a fixed range, the T22-003 merge counts, and the run's
 * and the baseline run's completeness as received. `unknown` and `staleAtMs` are the list widgets'
 * (T24-024, T24-033); absent = none.
 */
export interface Coverage {
  readonly total: number;
  readonly drawn: number;
  readonly keptMin: boolean;
  readonly keptMax: boolean;
  readonly keptWorst: number;
  readonly omittedWorst: number;
  readonly worstState: State | null;
  readonly outside: number;
  readonly duplicates: number;
  readonly conflicts: number;
  readonly query: Completeness;
  readonly baseline: Completeness | null;
  readonly unknown?:
    | { readonly reason: 'oldServer' }
    | { readonly reason: 'tagsStale'; readonly count: number }
    | { readonly reason: 'paged'; readonly pages: number };
  readonly staleAtMs?: number | null;
  /** Geomap counts before the cap (T24 §4.11, #184); absent = none. */
  readonly geo?: Readonly<Record<GeoCoverageCount, number>>;
  /** The map area's counts (T24-098, T22-006); absent = none. */
  readonly area?: {
    readonly outside: number;
    readonly unlocated: number;
    readonly unapplied: number;
  };
}

/** The geomap's coverage counts (T22-006, T22 §5.1 `Coverage.geo`). */
export type GeoCoverageCount =
  | 'notPlaced'
  | 'ambiguous'
  | 'locationsUnavailable'
  | 'outsideMap'
  | 'noValue'
  | 'infinite'
  | 'outOfRange';

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
  | {
      readonly kind: 'series';
      readonly series: readonly SeriesFrame[];
      /**
       * Line: the auto value domain and the summary's min, max and last use only samples with
       * fromMs ≤ t ≤ toMs (#304 §A.3); absent = every sample. Other kinds ignore it.
       */
      readonly fit?: TimeWindow;
      /** Line: fade from the series drawn before over 150 ms (ADR-0039); ignored with nothing drawn. */
      readonly transition?: 'crossfade';
    }
  | { readonly kind: 'heatmap'; readonly heatmap: HeatmapFrame }
  | { readonly kind: 'scalar'; readonly scalar: ScalarFrame }
  /** A bar chart's drawn rows, in draw order, and the panel's coverage (ADR-0028, T22 §5.1). */
  | {
      readonly kind: 'categories';
      readonly categories: readonly CategoryRow[];
      readonly coverage: Coverage;
    }
  /** A geomap's validated rows over its basemap (ADR-0027, T24 §5.15). */
  | { readonly kind: 'geo'; readonly geo: GeoFrame };

/** A basemap with nothing on it: an empty geomap frame's (ADR-0027). */
export const EMPTY_BASEMAP: Basemap = Object.freeze({
  countries: Object.freeze([]),
  coast: Object.freeze([]),
  border: Object.freeze([]),
});

/** The most rows a `categories` frame holds (T22-006, T22 §5.1). */
export const MAX_CATEGORIES = 200;

/** A coverage with nothing in it: no rows, a complete run and no baseline. */
export const EMPTY_COVERAGE: Coverage = Object.freeze({
  total: 0,
  drawn: 0,
  keptMin: false,
  keptMax: false,
  keptWorst: 0,
  omittedWorst: 0,
  worstState: null,
  outside: 0,
  duplicates: 0,
  conflicts: 0,
  query: Object.freeze({
    truncated: false,
    warnings: [],
    infos: [],
    queryId: null,
    dataAgeMs: null,
    readCache: null,
    readCacheThroughMs: null,
  }),
  baseline: null,
});

export type FrameDataIssue =
  | { code: 'kind' }
  | { code: 'key'; key: string }
  | { code: 'length'; key: string; timestamps: number; values: number }
  | { code: 'order'; key: string }
  | { code: 'cells'; columns: number; buckets: number; cells: number }
  | { code: 'bounds' }
  | { code: 'finite' }
  | { code: 'grid'; key: string }
  | { code: 'cap'; count: number; max: number }
  /** A geomap row set breaks T24-089 (`validateGeoRows`): the first failing check. */
  | { code: 'geo'; detail: 'order' | 'value' | 'state' | 'draw' | 'group' | 'coverage' };

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
 * `bars` need series, `heatmap` a heatmap, `stat` a scalar or series (the first series' last finite
 * value is shown), `barchart` categories and `geomap` geo data (its rows are validated by the
 * panel's plan, `validateGeoRows`).
 */
export function validateFrameData(spec: VisSpec, data: FrameData): FrameDataIssue | null {
  switch (spec.kind) {
    case 'line':
      if (data.kind !== 'series') return { code: 'kind' };
      // #304 §A.3: a fit window is finite with fromMs ≤ toMs.
      if (
        data.fit !== undefined &&
        !(
          Number.isFinite(data.fit.fromMs) &&
          Number.isFinite(data.fit.toMs) &&
          data.fit.fromMs <= data.fit.toMs
        )
      ) {
        return { code: 'finite' };
      }
      return seriesIssue(data.series);
    case 'bars':
      if (data.kind !== 'series') return { code: 'kind' };
      return seriesIssue(data.series) ?? gridIssue(data.series);
    case 'heatmap':
      return data.kind === 'heatmap' ? heatmapIssue(data.heatmap) : { code: 'kind' };
    case 'stat':
      if (data.kind === 'scalar') return null;
      return data.kind === 'series' ? seriesIssue(data.series) : { code: 'kind' };
    case 'barchart':
      return data.kind === 'categories' ? categoriesIssue(data.categories) : { code: 'kind' };
    case 'geomap':
      return data.kind === 'geo' ? null : { code: 'kind' };
  }
}

/** ADR-0028: at most `MAX_CATEGORIES` rows, then the first key that is malformed or repeated. */
function categoriesIssue(rows: readonly CategoryRow[]): FrameDataIssue | null {
  if (rows.length > MAX_CATEGORIES) {
    return { code: 'cap', count: rows.length, max: MAX_CATEGORIES };
  }
  const seen = new Set<string>();
  for (const r of rows) {
    if (!KEY_PATTERN.test(r.key) || seen.has(r.key)) return { code: 'key', key: r.key };
    seen.add(r.key);
  }
  return null;
}

/**
 * Data that draws an empty chart of `spec`'s kind: no series, a 0 × 0 heatmap, `NaN`, no bars or
 * no rows over an empty basemap.
 */
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
    case 'barchart':
      return { kind: 'categories', categories: [], coverage: EMPTY_COVERAGE };
    case 'geomap':
      return {
        kind: 'geo',
        geo: {
          rows: [],
          groups: [],
          coverage: EMPTY_COVERAGE,
          groupBy: null,
          seq: 0,
          shown: new Uint32Array(0),
          basemap: EMPTY_BASEMAP,
        },
      };
  }
}

/** A label value as `seriesName` writes it: `"…"` with `\\`, `"` and LF escaped (T22-004). */
export function quoted(v: string): string {
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
  const k = f.edges.length - 1;
  if (k < 1 || k > 200 || !isIncreasing(f.edges)) return false;
  const nonNegative = (a: Float64Array): boolean => a.every((c) => Number.isFinite(c) && c >= 0);
  if (f.counts.length !== f.groups.length * k || !nonNegative(f.counts)) return false;
  const { offsets, bins, counts } = f.contrib;
  if (offsets.length !== f.series.length + 1 || offsets[0] !== 0) return false;
  for (let i = 1; i < offsets.length; i++)
    if ((offsets[i] ?? 0) < (offsets[i - 1] ?? 0)) return false;
  const entries = offsets[offsets.length - 1];
  if (entries !== bins.length || entries !== counts.length || !nonNegative(counts)) return false;
  if (bins.some((b) => b >= k)) return false;
  const sorted = f.sorted.offsets;
  if (sorted.length !== f.sourceGroups.length + 1 || sorted[0] !== 0) return false;
  return sorted[sorted.length - 1] === f.sorted.values.length;
}
