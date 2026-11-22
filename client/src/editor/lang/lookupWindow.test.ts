import { describe, expect, it } from 'vitest';
import { minuteWindow, secondWindow } from './lookupWindow';

// Plan #66 Part A §3.6: the completion windows, moved from promSource's `snapped`.
const at = (h: number, m: number, s = 0, ms = 0) => Date.UTC(2026, 10, 19, h, m, s, ms);
const W = { fromMs: at(12, 0, 30, 500), toMs: at(13, 0, 10) };

describe('unit:lookup-window', () => {
  it('minutes: start floored, end ceiled', () => {
    expect(minuteWindow(W)).toEqual({ fromMs: at(12, 0), toMs: at(13, 1) });
  });

  it('minutes: widened to one minute when start and end meet', () => {
    expect(minuteWindow({ fromMs: at(12, 0, 10), toMs: at(12, 0, 20) })).toEqual({
      fromMs: at(12, 0),
      toMs: at(12, 1),
    });
    // On a whole minute, floor and ceil meet: only the widening gives the minute.
    expect(minuteWindow({ fromMs: at(12, 0), toMs: at(12, 0) })).toEqual({
      fromMs: at(12, 0),
      toMs: at(12, 1),
    });
  });

  it('seconds: snapped without widening', () => {
    expect(secondWindow(W)).toEqual({ fromMs: at(12, 0, 30), toMs: at(13, 0, 10) });
    expect(secondWindow({ fromMs: at(12, 0, 10), toMs: at(12, 0, 10) })).toEqual({
      fromMs: at(12, 0, 10),
      toMs: at(12, 0, 10),
    });
  });
});
