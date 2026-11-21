/**
 * A deterministic allocation gate: counts the `Float64Array` elements created while `f` runs, by
 * swapping the global constructor for a counting subclass. When the count would pass `budget`,
 * the allocation throws instead of happening, so an unbounded allocation fails the caller's
 * assertion on `elements` rather than exhausting memory.
 */
const Real = globalThis.Float64Array;

/** Thrown in place of an allocation over the budget. */
export class AllocationBudgetExceeded extends Error {}

export interface Allocations<T> {
  /** `f`'s result; `undefined` when an allocation passed the budget. */
  readonly value: T | undefined;
  /** Float64 elements requested, including the one over the budget. */
  readonly elements: number;
}

function lengthOf(arg: unknown): number {
  if (typeof arg === 'number') return arg;
  if (arg instanceof ArrayBuffer) return arg.byteLength / 8;
  if (arg !== null && typeof arg === 'object' && 'length' in arg) return Number(arg.length);
  // An iterable without `length` (a Set): its size, else counted after construction.
  if (arg instanceof Set) return arg.size;
  return 0;
}

export function countFloat64<T>(f: () => T, budget: number): Allocations<T> {
  let elements = 0;
  class Counting extends Real {
    constructor(...args: unknown[]) {
      elements += lengthOf(args[0]);
      if (elements > budget) throw new AllocationBudgetExceeded(`${elements} > ${budget}`);
      super(...(args as [number]));
    }
  }
  globalThis.Float64Array = Counting;
  try {
    return { value: f(), elements };
  } catch (e) {
    if (e instanceof AllocationBudgetExceeded) return { value: undefined, elements };
    throw e;
  } finally {
    globalThis.Float64Array = Real;
  }
}
