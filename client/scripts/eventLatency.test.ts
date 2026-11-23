// unit:event-latency (plan #66 Part B, B.3).
import { describe, expect, it } from 'vitest';
import type { TraceEvent } from './longTasks.ts';
import { eventLatencies, SCROLL_UPDATE_TYPES } from './eventLatency.ts';

const at = { pid: 1, tid: 9 };
const ev = (ph: 'b' | 'e', id: string, ts: number, type?: string): TraceEvent => ({
  name: 'EventLatency',
  ph,
  ts,
  ...at,
  id,
  ...(type === undefined ? {} : { args: { event_latency: { event_type: type } } }),
});

describe('unit:event-latency', () => {
  it('E1 the scroll-update durations, other types skipped', () => {
    const trace: TraceEvent[] = [
      ev('b', '0x1', 1_000, 'GESTURE_SCROLL_UPDATE'),
      ev('e', '0x1', 13_000),
      ev('b', '0x2', 20_000, 'MOUSE_PRESSED'),
      ev('e', '0x2', 25_000),
      ev('b', '0x3', 40_000, 'INERTIAL_GESTURE_SCROLL_UPDATE'),
      ev('e', '0x3', 70_000),
    ];
    expect(eventLatencies(trace, { types: SCROLL_UPDATE_TYPES })).toEqual([12, 30]);
  });

  it('E2 an unmatched begin is an error naming it', () => {
    const trace: TraceEvent[] = [
      ev('b', '0x1', 1_000, 'GESTURE_SCROLL_UPDATE'),
      ev('e', '0x1', 13_000),
      ev('b', '0x7', 20_000, 'FIRST_GESTURE_SCROLL_UPDATE'),
    ];
    expect(() => eventLatencies(trace, { types: SCROLL_UPDATE_TYPES })).toThrow(/0x7/);
  });
});
