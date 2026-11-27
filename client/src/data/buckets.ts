/** Stub (tests first, #304). */
export const BUCKET_STEPS = 256;
export const MAX_RUN_BUCKETS = 42;
export const bucketOf = (_tMs: number, _stepMs: number): number => 0;
export const bucketStartMs = (_k: number, _stepMs: number): number => 0;
export const bucketLastMs = (_k: number, _stepMs: number): number => 0;
export interface Run {
  readonly k0: number;
  readonly k1: number;
}
export function runsOf(_ks: readonly number[]): Run[] {
  return [];
}
