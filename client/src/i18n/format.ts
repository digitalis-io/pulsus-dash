/**
 * Date and time formatting, locale en-GB (T08-027). The only module that creates `Intl` formatters;
 * they are cached per time zone.
 */
import type { ContextSearch, RefreshInterval } from '../state/contextSearch';
import { isAbsolute, resolveTimeString } from '../state/timeExpr';
import { t, type MessageId } from './t';

const LOCALE = 'en-GB';

type Kind = 'date' | 'time' | 'dayMonth' | 'hourMinute' | 'zoneShort' | 'zoneLong';

const OPTIONS: Readonly<Record<Kind, Intl.DateTimeFormatOptions>> = {
  date: { day: 'numeric', month: 'short', year: 'numeric' },
  time: { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' },
  dayMonth: { day: 'numeric', month: 'short' },
  hourMinute: { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
  zoneShort: { timeZoneName: 'short' },
  zoneLong: { timeZoneName: 'longOffset' },
};

const cache = new Map<string, Intl.DateTimeFormat>();

function formatter(kind: Kind, timeZone: string): Intl.DateTimeFormat {
  const key = `${kind}|${timeZone}`;
  let f = cache.get(key);
  if (f === undefined) {
    f = new Intl.DateTimeFormat(LOCALE, { ...OPTIONS[kind], timeZone });
    cache.set(key, f);
  }
  return f;
}

function zonePart(kind: 'zoneShort' | 'zoneLong', tz: string, atMs: number): string {
  return (
    formatter(kind, tz)
      .formatToParts(atMs)
      .find((p) => p.type === 'timeZoneName')?.value ?? tz
  );
}

/** The browser's IANA time zone. */
export function browserTimeZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function formatDate(ms: number, tz: string): string {
  return formatter('date', tz).format(ms);
}

export function formatTime(ms: number, tz: string): string {
  return formatter('time', tz).format(ms);
}

export function formatRange(fromMs: number, toMs: number, tz: string): string {
  const fromDate = formatDate(fromMs, tz);
  const toDate = formatDate(toMs, tz);
  if (fromDate === toDate) {
    return `${fromDate}, ${formatTime(fromMs, tz)} – ${formatTime(toMs, tz)}`;
  }
  return `${fromDate}, ${formatTime(fromMs, tz)} – ${toDate}, ${formatTime(toMs, tz)}`;
}

export function formatRangeShort(fromMs: number, toMs: number, tz: string): string {
  const zone = zonePart('zoneShort', tz, toMs);
  const hm = (ms: number): string => formatter('hourMinute', tz).format(ms);
  if (formatDate(fromMs, tz) === formatDate(toMs, tz)) {
    return `${hm(fromMs)} – ${hm(toMs)} ${zone}`;
  }
  const dm = (ms: number): string => formatter('dayMonth', tz).format(ms);
  return `${dm(fromMs)} ${hm(fromMs)} – ${dm(toMs)} ${hm(toMs)} ${zone}`;
}

/** 'Europe/London (GMT)', 'America/New_York (GMT-05:00)'; a zero offset is shown as plain GMT. */
export function formatZone(tz: string, atMs: number): string {
  const offset = zonePart('zoneLong', tz, atMs).replace(/^GMT[+-−]00:00$/, 'GMT');
  return `${tz} (${offset})`;
}

/** The unit of a chart value (VL-012). */
export type Unit =
  | { readonly kind: 'none' }
  | { readonly kind: 'time'; readonly base: 'ns' | 'us' | 'ms' | 's' }
  | { readonly kind: 'bytes' }
  | { readonly kind: 'percent' }
  | { readonly kind: 'percentunit' }
  | { readonly kind: 'suffix'; readonly suffix: string };

export function formatValue(_v: number, _unit: Unit): string {
  throw new Error('not implemented');
}

export function formatHourMinute(_ms: number, _tz: string): string {
  throw new Error('not implemented');
}

export function formatDayMonth(_ms: number, _tz: string): string {
  throw new Error('not implemented');
}

export const QUICK_RANGES = [
  '5m',
  '15m',
  '30m',
  '1h',
  '3h',
  '6h',
  '12h',
  '24h',
  '2d',
  '7d',
  '30d',
] as const;
export type QuickRange = (typeof QUICK_RANGES)[number];

const QUICK_LABELS: Readonly<Record<QuickRange, MessageId>> = {
  '5m': 'time.quick.5m',
  '15m': 'time.quick.15m',
  '30m': 'time.quick.30m',
  '1h': 'time.quick.1h',
  '3h': 'time.quick.3h',
  '6h': 'time.quick.6h',
  '12h': 'time.quick.12h',
  '24h': 'time.quick.24h',
  '2d': 'time.quick.2d',
  '7d': 'time.quick.7d',
  '30d': 'time.quick.30d',
};

export function quickRangeLabel(q: QuickRange): string {
  return t(QUICK_LABELS[q]);
}

/** The quick range `s` is, if any (`from = now-<x>`, `to = now`). */
export function quickRangeOf(s: ContextSearch): QuickRange | null {
  if (s.to !== 'now' || !s.from.startsWith('now-')) return null;
  const x = s.from.slice(4);
  return (QUICK_RANGES as readonly string[]).includes(x) ? (x as QuickRange) : null;
}

export function describeRange(s: ContextSearch, nowMs: number, tz: string): string {
  const q = quickRangeOf(s);
  if (q !== null) return quickRangeLabel(q);
  if (isAbsolute(s.from) && isAbsolute(s.to)) {
    return formatRange(
      resolveTimeString(s.from, nowMs, tz),
      resolveTimeString(s.to, nowMs, tz),
      tz,
    );
  }
  return t('time.rangeRaw', { from: s.from, to: s.to });
}

const REFRESH_LABELS: Readonly<Record<RefreshInterval, MessageId>> = {
  off: 'refresh.off',
  '10s': 'refresh.10s',
  '30s': 'refresh.30s',
  '1m': 'refresh.1m',
  '5m': 'refresh.5m',
  '15m': 'refresh.15m',
};

/** `Off`, `10s`, … for menus and accessible names. */
export function refreshLabel(r: RefreshInterval): string {
  return t(REFRESH_LABELS[r]);
}
