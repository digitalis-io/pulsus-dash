import { describe, expect, it } from 'vitest';
import { ulpDistance } from './ulp.ts';

describe('unit:ulp-distance', () => {
  it('counts the doubles between two values', () => {
    expect(ulpDistance(1, 1)).toBe(0);
    expect(ulpDistance(1, 1 + Number.EPSILON)).toBe(1);
    expect(ulpDistance(1 + 4 * Number.EPSILON, 1)).toBe(4);
    expect(ulpDistance(0, -0)).toBe(0);
    expect(ulpDistance(Number.MIN_VALUE, -Number.MIN_VALUE)).toBe(2);
    expect(ulpDistance(0, 5 * Number.MIN_VALUE)).toBe(5);
    expect(ulpDistance(-1, -1 - 2 * Number.EPSILON)).toBe(2);
    expect(ulpDistance(Number.MAX_VALUE, Number.MAX_VALUE)).toBe(0);
  });

  it('plan 6 §10 Q1 cases', () => {
    expect(ulpDistance(1, 1)).toBe(0);
    expect(ulpDistance(1, 1 + Number.EPSILON)).toBe(1); // nextUp(1)
    expect(ulpDistance(-0, 0)).toBe(0);
    expect(ulpDistance(-Number.MIN_VALUE, Number.MIN_VALUE)).toBe(2);
    // ticks-extreme.json row 391: WebKit's max against the pinned (V8) max.
    expect(ulpDistance(5.000000000000001e151, 4.9999999999999996e151)).toBe(2);
  });

  it('is Infinity for NaN or a non-finite value that differs', () => {
    expect(ulpDistance(NaN, 1)).toBe(Infinity);
    expect(ulpDistance(NaN, NaN)).toBe(Infinity);
    expect(ulpDistance(Infinity, Number.MAX_VALUE)).toBe(Infinity);
    expect(ulpDistance(Infinity, Infinity)).toBe(0);
  });
});
