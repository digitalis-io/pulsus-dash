/**
 * Time-axis ticks (plan #58 Appendix A §A.4, VIZ-013). Candidates are generated on the local wall
 * clock and converted with `'compatible'` disambiguation, so DST days keep round local labels; a
 * candidate that does not move forward in time (the repeated hour) is dropped, and a greedy pass
 * keeps the labels apart.
 */
import {
  CalendarDate,
  fromAbsolute,
  toCalendarDateTime,
  toZoned,
  type CalendarDateTime,
} from '@internationalized/date';
import { formatDayMonth, formatHourMinute, formatTime } from '../../i18n/format';

export interface TimeTick {
  readonly ms: number;
  readonly x: number;
  readonly label: string;
  readonly major: boolean;
}

export const SUB_DAY_STEPS_S: readonly number[] = [
  1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200,
];
export const DAY_STEPS: readonly number[] = [1, 2, 7, 14];

const DAY_MS = 86_400_000;

interface Step {
  readonly kind: 'sub' | 'day';
  /** Seconds for sub-day steps, days for day steps. */
  readonly n: number;
  readonly ms: number;
}

const STEPS: readonly Step[] = [
  ...SUB_DAY_STEPS_S.map((n) => ({ kind: 'sub' as const, n, ms: n * 1000 })),
  ...DAY_STEPS.map((n) => ({ kind: 'day' as const, n, ms: n * DAY_MS })),
];

interface Args {
  fromMs: number;
  toMs: number;
  widthPx: number;
  timeZone: string;
  measure: (s: string) => number;
  minGapPx: number;
}

function sampleWidth(s: Step, a: Args): number {
  if (s.kind === 'day') return a.measure(formatDayMonth(a.fromMs, a.timeZone));
  if (s.n < 60) return a.measure('00:00:00');
  return Math.max(
    a.measure('00:00'),
    a.measure(formatDayMonth(a.fromMs, a.timeZone)),
    a.measure(formatDayMonth(a.toMs, a.timeZone)),
  );
}

function isMidnight(ms: number, tz: string): boolean {
  const c = fromAbsolute(ms, tz);
  return c.hour === 0 && c.minute === 0 && c.second === 0 && c.millisecond === 0;
}

/** Candidate instants and labels for one step, up to the first instant past `toMs`. */
function candidates(s: Step, a: Args): { ms: number; label: string; major: boolean }[] {
  const tz = a.timeZone;
  const out: { ms: number; label: string; major: boolean }[] = [];
  const limit = 10_000;
  if (s.kind === 'sub') {
    const start = toCalendarDateTime(fromAbsolute(a.fromMs, tz));
    const sinceMidnight = start.hour * 3600 + start.minute * 60 + start.second;
    let wall: CalendarDateTime = start
      .set({ hour: 0, minute: 0, second: 0, millisecond: 0 })
      .add({ seconds: Math.floor(sinceMidnight / s.n) * s.n });
    for (let i = 0; i < limit; i++) {
      const ms = toZoned(wall, tz, 'compatible').toDate().getTime();
      if (ms > a.toMs) break;
      const midnight = s.n >= 60 && isMidnight(ms, tz);
      const label =
        s.n < 60
          ? formatTime(ms, tz)
          : midnight
            ? formatDayMonth(ms, tz)
            : formatHourMinute(ms, tz);
      out.push({ ms, label, major: midnight });
      wall = wall.add({ seconds: s.n });
    }
    return out;
  }
  const first = toCalendarDateTime(fromAbsolute(a.fromMs, tz));
  let day = new CalendarDate(first.year, first.month, first.day);
  const epochDay = (d: CalendarDate): number => Date.UTC(d.year, d.month - 1, d.day) / DAY_MS;
  while (((epochDay(day) % s.n) + s.n) % s.n !== 0) day = day.add({ days: 1 });
  for (let i = 0; i < limit; i++) {
    const ms = toZoned(day, tz, 'compatible').toDate().getTime();
    if (ms > a.toMs) break;
    out.push({ ms, label: formatDayMonth(ms, tz), major: true });
    day = day.add({ days: s.n });
  }
  return out;
}

function ticksFor(s: Step, a: Args): TimeTick[] {
  const range = a.toMs - a.fromMs;
  const kept: TimeTick[] = [];
  let lastMs = -Infinity;
  for (const c of candidates(s, a)) {
    if (c.ms <= lastMs) continue;
    lastMs = c.ms;
    const x = ((c.ms - a.fromMs) / range) * a.widthPx;
    const w = a.measure(c.label);
    if (x - w / 2 < 0 || x + w / 2 > a.widthPx) continue;
    kept.push({ ms: c.ms, x, label: c.label, major: c.major });
  }
  const out: TimeTick[] = [];
  let right = -Infinity;
  for (const t of kept) {
    const w = a.measure(t.label);
    if (t.x - w / 2 - right < a.minGapPx) continue;
    out.push(t);
    right = t.x + w / 2;
  }
  return out;
}

/**
 * Ticks for the window, using the smallest step whose labels fit. If that step leaves no tick
 * inside the plot (a window shorter than the step), smaller steps are tried; the greedy pass keeps
 * their labels apart.
 */
export function timeTicks(a: Args): TimeTick[] {
  const range = a.toMs - a.fromMs;
  if (!(range > 0) || !(a.widthPx > 0)) return [];
  let chosen = STEPS.findIndex((s) => (a.widthPx * s.ms) / range >= sampleWidth(s, a) + a.minGapPx);
  if (chosen < 0) chosen = STEPS.length - 1;
  for (let i = chosen; i >= 0; i--) {
    const s = STEPS[i];
    if (s === undefined) continue;
    const ticks = ticksFor(s, a);
    if (ticks.length > 0) return ticks;
  }
  return [];
}
