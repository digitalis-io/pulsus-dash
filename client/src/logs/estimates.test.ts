// unit:log-stream (plan #66 Part B §3.5): the wrapped-row estimate cache stays bounded.
import { describe, expect, it } from 'vitest';
import { RowEstimates } from './estimates';

const filled = (from: number, to: number): RowEstimates => {
  const e = new RowEstimates();
  for (let o = from; o < to; o += 1) e.set(o, 20 + o);
  return e;
};

describe('RowEstimates', () => {
  it('keeps the estimates inside the retained range only', () => {
    const e = filled(0, 100);
    e.retain(30, 60);
    expect(e.size).toBe(30);
    expect(e.get(29)).toBeUndefined();
    expect(e.get(30)).toBe(50);
    expect(e.get(59)).toBe(79);
    expect(e.get(60)).toBeUndefined();
  });

  it('stays bounded over a window moving without end, in both directions', () => {
    const e = new RowEstimates();
    for (let k = 0; k < 50; k += 1) {
      for (let o = k * 1000; o < k * 1000 + 2000; o += 1) e.set(o, 20);
      e.retain(k * 1000, k * 1000 + 2000);
      expect(e.size).toBe(2000);
    }
    // A head re-fetch: the window moves back.
    e.retain(47_000, 49_000);
    for (let o = 46_000; o < 47_000; o += 1) e.set(o, 20);
    e.retain(46_000, 48_000);
    expect(e.size).toBe(2000);
    expect(e.get(45_999)).toBeUndefined();
    expect(e.get(48_000)).toBeUndefined();
  });

  it('drops everything when the retained range is empty or disjoint', () => {
    const e = filled(0, 10);
    e.retain(1_000_000, 1_000_010);
    expect(e.size).toBe(0);
    e.set(5, 20);
    e.retain(5, 5);
    expect(e.size).toBe(0);
  });
});
