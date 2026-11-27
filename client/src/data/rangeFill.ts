/** Stub (tests first, #304 Part B). */
import type { RangeResult } from './decode';

/** One step's held buckets of a family, as parts. */
export interface StepSource {
  readonly stepMs: number;
  /** Held buckets, ascending, each with the segment result that holds it. */
  readonly buckets: ReadonlyMap<number, RangeResult>;
}

export interface FillInput {
  readonly stepMs: number;
  readonly k0: number;
  readonly k1: number;
  /** The view-step buckets held (k → result). */
  readonly own: ReadonlyMap<number, RangeResult>;
  readonly others: readonly StepSource[];
}

export interface Filled {
  readonly result: RangeResult;
  readonly rank: 0 | 1;
  /** The step each missing span was filled from (null: a gap), in span order. */
  readonly sources: readonly (number | null)[];
}

export function fillRange(_i: FillInput): Filled {
  throw new Error('stub');
}
