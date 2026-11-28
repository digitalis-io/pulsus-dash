/**
 * The range store's assembly arithmetic (#304 §4.4): stitching segment parts into one held span,
 * slicing the visible grid out of it, and merging completeness. Pure functions of their inputs.
 *
 * Presence (T02 §4.4, T04-005): a series a part does not return is absent there; absent and
 * present-NaN both draw as gaps, never interpolated, but stay distinct in `absent`.
 */
import { bucketLastMs, bucketStartMs } from './buckets';
import type { Completeness, RangeResult } from './decode';
import type { SeriesFrame } from './frames';

/** A segment's part of a span: buckets `k0 ≤ k < k1` of `result` (which may cover more). */
export interface Part {
  readonly k0: number;
  readonly k1: number;
  readonly result: RangeResult;
}

/** The bytes a stitched span of `series × points` takes (values, one timestamps array, masks). */
export const spanBytes = (series: number, points: number): number =>
  8 * points * (series + 1) + Math.ceil((points * series) / 8);

/**
 * `completeness` of parts: `truncated` any; `warnings`, `infos` the union in order; the rest from
 * `end` (the part holding the visible grid's last point).
 */
export function mergeCompleteness(parts: readonly RangeResult[], end: RangeResult): Completeness {
  const warnings: string[] = [];
  const infos: string[] = [];
  for (const p of parts) {
    for (const w of p.completeness.warnings) if (!warnings.includes(w)) warnings.push(w);
    for (const i of p.completeness.infos) if (!infos.includes(i)) infos.push(i);
  }
  return {
    ...end.completeness,
    truncated: parts.some((p) => p.completeness.truncated),
    warnings,
    infos,
  };
}

/** The distinct series keys of `results`, ascending in time, each in server order. */
export function keysOf(results: readonly RangeResult[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of results) {
    for (const s of r.series) {
      if (seen.has(s.key)) continue;
      seen.add(s.key);
      out.push(s.key);
    }
  }
  return out;
}

/**
 * One span over buckets `k0 ≤ k < k1` at `stepMs` from parts in ascending time: one shared
 * `timestamps` over the span's grid; per key `values` NaN-filled and `absent` 1-filled, each
 * part's run copied at its offset. A copy (by value).
 */
export function stitch(
  parts: readonly Part[],
  k0: number,
  k1: number,
  stepMs: number,
): RangeResult {
  const startMs = bucketStartMs(k0, stepMs);
  const endMs = bucketLastMs(k1 - 1, stepMs);
  const n = Math.round((endMs - startMs) / stepMs) + 1;
  const ts = new Float64Array(n);
  for (let i = 0; i < n; i++) ts[i] = startMs + i * stepMs;
  const results = parts.map((p) => p.result);
  const order = keysOf(results);
  const values = new Map<string, Float64Array>();
  const absent = new Map<string, Uint8Array>();
  const labels = new Map<string, SeriesFrame['labels']>();
  for (const k of order) {
    values.set(k, new Float64Array(n).fill(NaN));
    absent.set(k, new Uint8Array(n).fill(1));
  }
  for (const p of parts) {
    const from = bucketStartMs(p.k0, stepMs);
    const to = bucketLastMs(p.k1 - 1, stepMs);
    const src = Math.round((from - p.result.startMs) / stepMs);
    const dst = Math.round((from - startMs) / stepMs);
    const len = Math.round((to - from) / stepMs) + 1;
    p.result.series.forEach((s, i) => {
      if (!labels.has(s.key)) labels.set(s.key, s.labels);
      const v = values.get(s.key);
      const a = absent.get(s.key);
      if (v === undefined || a === undefined) return;
      v.set(s.values.subarray(src, src + len), dst);
      const m = p.result.absent?.[i] ?? null;
      if (m === null) a.fill(0, dst, dst + len);
      else a.set(m.subarray(src, src + len), dst);
    });
  }
  const series: SeriesFrame[] = order.map((key) => ({
    key,
    labels: labels.get(key) ?? {},
    timestamps: ts,
    values: values.get(key) ?? new Float64Array(n),
  }));
  const masks = order.map((key) => {
    const a = absent.get(key);
    return a === undefined || a.every((x) => x === 0) ? null : a;
  });
  const last = results.at(-1);
  if (last === undefined) throw new Error('stitch: no parts');
  return {
    planned: last.planned,
    startMs,
    endMs,
    stepMs,
    series,
    completeness: mergeCompleteness(results, last),
    ...(masks.some((m) => m !== null) ? { absent: masks } : {}),
  };
}

/**
 * The grid `[fromMs, toMs]` of `held` (zero copy): every array a `subarray`. A series is kept iff
 * it has a present point (`absent` 0) in the slice, whatever its values.
 */
export function slice(
  held: RangeResult,
  fromMs: number,
  toMs: number,
  completeness: Completeness,
  planned: RangeResult['planned'],
): RangeResult {
  const step = held.stepMs;
  const i0 = Math.max(0, Math.round((fromMs - held.startMs) / step));
  const i1 = Math.round((toMs - held.startMs) / step) + 1;
  // One view of a shared timestamps array, per array (the JSON decode gives each series its own).
  const views = new Map<Float64Array, Float64Array>();
  const tsOf = (t: Float64Array): Float64Array => {
    let v = views.get(t);
    if (v === undefined) {
      v = t.subarray(i0, i1);
      views.set(t, v);
    }
    return v;
  };
  const series: SeriesFrame[] = [];
  const masks: (Uint8Array | null)[] = [];
  held.series.forEach((s, i) => {
    const m = held.absent?.[i] ?? null;
    const sub = m === null ? null : m.subarray(i0, i1);
    if (sub !== null && sub.every((x) => x === 1)) return;
    series.push({ ...s, timestamps: tsOf(s.timestamps), values: s.values.subarray(i0, i1) });
    masks.push(sub !== null && sub.some((x) => x === 1) ? sub : null);
  });
  return {
    planned,
    startMs: fromMs,
    endMs: toMs,
    stepMs: step,
    series,
    completeness,
    ...(masks.some((m) => m !== null) ? { absent: masks } : {}),
  };
}
