/** `unit:baseline-window` (plan #173 Part 3a §3.8; T22-012). */
import { describe, expect, it } from 'vitest';
import { baselineOffset, OFFSET_MS, shiftWindow } from './baseline';

describe('unit:baseline-window', () => {
  it('the offset: the option, else 1 d with the ghost on, else none', () => {
    expect(baselineOffset(undefined, false)).toBeNull();
    expect(baselineOffset(undefined, true)).toBe('1d');
    expect(baselineOffset({ baselineOffset: '7d' }, true)).toBe('7d');
    expect(baselineOffset({ baselineOffset: '28d' }, false)).toBe('28d');
    expect(OFFSET_MS).toEqual({
      '1h': 3_600_000,
      '1d': 86_400_000,
      '7d': 604_800_000,
      '28d': 2_419_200_000,
    });
  });

  it('both ends move back by the offset', () => {
    const t = Date.UTC(2026, 10, 19, 12);
    expect(shiftWindow({ fromMs: t, toMs: t + 3_600_000 }, '1d')).toEqual({
      fromMs: t - 86_400_000,
      toMs: t + 3_600_000 - 86_400_000,
    });
  });
});
