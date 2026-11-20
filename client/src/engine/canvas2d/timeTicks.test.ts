import { fromAbsolute, toCalendarDateTime } from '@internationalized/date';
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../test/random';
import { timeTicks, type TimeTick } from './timeTicks';

const ZONES = ['Europe/London', 'UTC', 'America/New_York', 'Asia/Kolkata', 'Australia/Lord_Howe'];
const measure = (s: string): number => 7 * s.length;
const GAP = 8;
const YEAR_FROM = Date.UTC(2026, 0, 1);
const YEAR_TO = Date.UTC(2027, 0, 1);

function wallClock(ms: number, tz: string): number {
  // Local wall-clock time as a sortable number (calendar fields, not the instant).
  const c = toCalendarDateTime(fromAbsolute(ms, tz));
  return Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second, c.millisecond);
}

function checkProperties(ticks: TimeTick[], width: number, tz: string, what: string): void {
  expect(ticks.length, what).toBeGreaterThanOrEqual(1);
  for (let i = 0; i < ticks.length; i++) {
    const t = ticks[i];
    if (t === undefined) continue;
    const w = measure(t.label);
    expect(t.x - w / 2, `${what} box left ${t.label}`).toBeGreaterThanOrEqual(0);
    expect(t.x + w / 2, `${what} box right ${t.label}`).toBeLessThanOrEqual(width);
    const p = ticks[i - 1];
    if (p === undefined) continue;
    expect(t.ms, what).toBeGreaterThan(p.ms);
    expect(t.x, what).toBeGreaterThan(p.x);
    const gap = t.x - w / 2 - (p.x + measure(p.label) / 2);
    expect(gap, `${what} gap ${p.label}→${t.label}`).toBeGreaterThanOrEqual(GAP);
    expect(t.label, what).not.toBe(p.label);
    expect(wallClock(t.ms, tz), `${what} wall clock`).toBeGreaterThan(wallClock(p.ms, tz));
  }
}

describe('unit:ticks-prop time', () => {
  it('holds for 400 random windows, widths and zones', () => {
    const r = mulberry32(58);
    for (let i = 0; i < 400; i++) {
      const width = 200 + r() * 3_800;
      const range = Math.exp(
        Math.log(60_000) + r() * (Math.log(30 * 86_400_000) - Math.log(60_000)),
      );
      const tz = ZONES[Math.floor(r() * ZONES.length)] ?? 'UTC';
      const fromMs = Math.floor(YEAR_FROM + r() * (YEAR_TO - YEAR_FROM));
      const toMs = Math.floor(fromMs + range);
      const ticks = timeTicks({
        fromMs,
        toMs,
        widthPx: width,
        timeZone: tz,
        measure,
        minGapPx: GAP,
      });
      checkProperties(
        ticks,
        width,
        tz,
        `case ${String(i)} ${tz} ${new Date(fromMs).toISOString()} +${String(range)} @${String(width)}`,
      );
    }
  });

  it('holds for 40 windows over the London DST changes', () => {
    const r = mulberry32(158);
    const days = [Date.UTC(2026, 2, 29, 1), Date.UTC(2026, 9, 25, 1)];
    for (let i = 0; i < 40; i++) {
      const change = days[i % 2] ?? 0;
      const width = 200 + r() * 3_800;
      const range = Math.exp(
        Math.log(3_600_000) + r() * (Math.log(3 * 86_400_000) - Math.log(3_600_000)),
      );
      const fromMs = Math.floor(change - r() * range);
      const toMs = Math.ceil(Math.max(fromMs + range, change + 60_000));
      const ticks = timeTicks({
        fromMs,
        toMs,
        widthPx: width,
        timeZone: 'Europe/London',
        measure,
        minGapPx: GAP,
      });
      checkProperties(ticks, width, 'Europe/London', `dst case ${String(i)}`);
    }
  });
});

describe('unit:ticks-prop DST examples', () => {
  const labels = (fromIso: string, toIso: string): string[] =>
    timeTicks({
      fromMs: Date.parse(fromIso),
      toMs: Date.parse(toIso),
      widthPx: 1_000,
      timeZone: 'Europe/London',
      measure,
      minGapPx: GAP,
    }).map((t) => t.label);

  it('fall back: the repeated hour is not labelled twice', () => {
    expect(labels('2026-10-24T23:00:00Z', '2026-10-25T06:00:00Z')).toEqual([
      '00:30',
      '01:00',
      '01:30',
      '02:00',
      '02:30',
      '03:00',
      '03:30',
      '04:00',
      '04:30',
      '05:00',
      '05:30',
    ]);
  });

  it('spring forward: the missing hour is skipped', () => {
    expect(labels('2026-03-29T00:00:00Z', '2026-03-29T06:00:00Z')).toEqual([
      '00:30',
      '02:00',
      '02:30',
      '03:00',
      '03:30',
      '04:00',
      '04:30',
      '05:00',
      '05:30',
      '06:00',
      '06:30',
    ]);
  });
});
