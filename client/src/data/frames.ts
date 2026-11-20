/**
 * Chart frame data (plan #58 §3.2): series, heatmap and scalar frames, and their validation. The
 * component validates; the engine assumes valid data.
 */
import type { VisSpec } from '../engine/api';

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
