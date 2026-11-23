/**
 * The scroll-update `EventLatency` durations of a Chromium trace (plan #66 Part B, B.3): the
 * PRF-003/PRF-004 proxy of `bench:log-scroll`. Each `EventLatency` async event spans from the
 * input event's OS timestamp to the presentation feedback of the frame that shows it; a begin is
 * paired with its end by id. Only the begin carries `args.event_latency.event_type`.
 */
import type { TraceEvent } from './longTasks.ts';

export const SCROLL_UPDATE_TYPES = [
  'GESTURE_SCROLL_UPDATE',
  'FIRST_GESTURE_SCROLL_UPDATE',
  'INERTIAL_GESTURE_SCROLL_UPDATE',
] as const;

const idOf = (e: TraceEvent): string =>
  `${String(e.pid)}:${e.id ?? e.id2?.local ?? e.id2?.global ?? ''}`;

/** ms, one per event of `types`, in begin order; an event without a matching begin and end is an
 *  error naming it. */
export function eventLatencies(
  events: readonly TraceEvent[],
  o: { types: readonly string[] },
): number[] {
  const types = new Set(o.types);
  const begins = new Map<string, TraceEvent>();
  const out: { ts: number; ms: number }[] = [];
  const sorted = events
    .filter((e) => e.name === 'EventLatency' && (e.ph === 'b' || e.ph === 'e'))
    .sort((a, b) => a.ts - b.ts);
  for (const e of sorted) {
    const id = idOf(e);
    if (e.ph === 'b') {
      if (begins.has(id)) throw new Error(`EventLatency ${id}: a second begin before its end`);
      begins.set(id, e);
      continue;
    }
    const b = begins.get(id);
    if (b === undefined) throw new Error(`EventLatency ${id}: an end without a begin`);
    begins.delete(id);
    const type = b.args?.event_latency?.event_type ?? '';
    if (types.has(type)) out.push({ ts: b.ts, ms: (e.ts - b.ts) / 1000 });
  }
  for (const [id, b] of begins) {
    const type = b.args?.event_latency?.event_type ?? '?';
    throw new Error(`EventLatency ${id} (${type}): a begin without an end`);
  }
  return out.sort((a, b) => a.ts - b.ts).map((x) => x.ms);
}
