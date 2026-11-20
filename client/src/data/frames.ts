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

export function validateFrameData(_spec: VisSpec, _data: FrameData): FrameDataIssue | null {
  throw new Error('not implemented');
}

export function emptyFrameData(_spec: VisSpec): FrameData {
  throw new Error('not implemented');
}

export function seriesName(_labels: Readonly<Record<string, string>>): string {
  throw new Error('not implemented');
}
