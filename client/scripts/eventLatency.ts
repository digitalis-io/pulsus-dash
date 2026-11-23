/** Scroll-update `EventLatency` durations of a Chromium trace (plan #66 Part B, B.3). Stub. */
import type { TraceEvent } from './longTasks.ts';

export const SCROLL_UPDATE_TYPES = [
  'GESTURE_SCROLL_UPDATE',
  'FIRST_GESTURE_SCROLL_UPDATE',
  'INERTIAL_GESTURE_SCROLL_UPDATE',
] as const;

export function eventLatencies(
  events: readonly TraceEvent[],
  o: { types: readonly string[] },
): number[] {
  void [events, o];
  throw new Error('not implemented');
}
