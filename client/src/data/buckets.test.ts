import { describe, expect, it } from 'vitest';
import {
  BUCKET_STEPS,
  MAX_RUN_BUCKETS,
  bucketLastMs,
  bucketOf,
  bucketStartMs,
  runsOf,
} from './buckets';
import { MAX_STEPS } from './step';

describe('bucket math (#304 §3.1)', () => {
  it('bucket math', () => {
    expect(BUCKET_STEPS * MAX_RUN_BUCKETS).toBeLessThanOrEqual(MAX_STEPS);
    expect(bucketOf(3_840_000, 15_000)).toBe(1);
    expect(bucketOf(3_839_999, 15_000)).toBe(0);
    expect(bucketStartMs(1, 15_000)).toBe(3_840_000);
    expect(bucketLastMs(0, 15_000)).toBe(3_825_000);
    const ks = Array.from({ length: 100 }, (_, i) => i);
    expect(runsOf(ks)).toEqual([
      { k0: 0, k1: 42 },
      { k0: 42, k1: 84 },
      { k0: 84, k1: 100 },
    ]);
    expect(runsOf([3, 1, 2, 7, 7, 9])).toEqual([
      { k0: 1, k1: 4 },
      { k0: 7, k1: 8 },
      { k0: 9, k1: 10 },
    ]);
    expect(runsOf([])).toEqual([]);
  });
});
