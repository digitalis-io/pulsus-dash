/**
 * The range store's buckets (#304 §3.1, §A.11): bucket `k` of a step covers the grid points
 * `k·256·step … (k·256 + 255)·step`. A PromQL range value at a grid time depends only on that time
 * and the step, so buckets fetched apart stitch into exactly what one request would return.
 */
export const BUCKET_STEPS = 256;
/** 42 × 256 = 10 752 ≤ `MAX_STEPS` (11 000): the most buckets one request asks for. */
export const MAX_RUN_BUCKETS = 42;

export const bucketOf = (tMs: number, stepMs: number): number =>
  Math.floor(tMs / (BUCKET_STEPS * stepMs));
export const bucketStartMs = (k: number, stepMs: number): number => k * BUCKET_STEPS * stepMs;
export const bucketLastMs = (k: number, stepMs: number): number =>
  (k * BUCKET_STEPS + BUCKET_STEPS - 1) * stepMs;

/** Buckets `k0 ≤ k < k1`. */
export interface Run {
  readonly k0: number;
  readonly k1: number;
}

/** Bucket indices (any order, repeats allowed) as contiguous runs of at most 42, ascending. */
export function runsOf(ks: readonly number[]): Run[] {
  const sorted = [...new Set(ks)].sort((a, b) => a - b);
  const out: Run[] = [];
  let k0: number | null = null;
  let prev = 0;
  for (const k of sorted) {
    if (k0 !== null && k === prev + 1 && k - k0 < MAX_RUN_BUCKETS) {
      prev = k;
      continue;
    }
    if (k0 !== null) out.push({ k0, k1: prev + 1 });
    k0 = k;
    prev = k;
  }
  if (k0 !== null) out.push({ k0, k1: prev + 1 });
  return out;
}

/** Every bucket of a run, ascending. */
export function bucketsOf(r: Run): number[] {
  const out: number[] = [];
  for (let k = r.k0; k < r.k1; k++) out.push(k);
  return out;
}
