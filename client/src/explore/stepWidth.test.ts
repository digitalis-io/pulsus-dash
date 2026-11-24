// unit:step-width (plan #66 Part C §3.6, §5.1; PRF-030).
import { describe, expect, it } from 'vitest';
import { stepWidth } from './stepWidth';

const W0 = Date.UTC(2026, 10, 19, 12);
const HOUR = { fromMs: W0, toMs: W0 + 3_600_000 };
const FIVE_MIN = { fromMs: W0, toMs: W0 + 300_000 };

describe('unit:step-width', () => {
  it('holds the width per grid step', () => {
    expect(stepWidth(null, HOUR, null)).toBeNull();
    const a = stepWidth(null, HOUR, 990);
    expect(a).toEqual({ stepMs: 5000, widthPx: 990 });
    expect(stepWidth(a, HOUR, 1000)).toBe(a);
    expect(stepWidth(a, HOUR, 700)).toEqual({ stepMs: 10_000, widthPx: 700 });
    expect(stepWidth(null, FIVE_MIN, 990)).toEqual({ stepMs: 1000, widthPx: 990 });
    expect(stepWidth(a, HOUR, null)).toBe(a);
  });

  it('a width without a grid is no step', () => {
    expect(stepWidth(null, { fromMs: 0, toMs: Date.UTC(2100, 0, 1) }, 1)).toBeNull();
  });
});
