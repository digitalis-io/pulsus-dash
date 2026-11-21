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

/** Three significant digits, or the rounded integer from 100; trailing zeros dropped. */
function sig(x: number): string {
  if (Math.abs(x) >= 100) return String(Math.round(x));
  const [mantissa = '', exponent] = x.toPrecision(3).split('e');
  const m = mantissa.includes('.') ? mantissa.replace(/0+$/, '').replace(/\.$/, '') : mantissa;
  return exponent === undefined ? m : `${m}e${exponent}`;
}

interface Scale {
  /** Size of the unit in the base unit. */
  readonly size: number;
  readonly text: string;
}

/** The largest scale not above `abs`, carried to the next one while the digits reach its size. */
function scaled(abs: number, scales: readonly Scale[], space: string): string {
  let i = 0;
  while (i + 1 < scales.length && abs >= (scales[i + 1]?.size ?? Infinity)) i += 1;
  for (;;) {
    const s = scales[i];
    if (s === undefined) return sig(abs);
    const digits = sig(abs / s.size);
    const next = scales[i + 1];
    if (next !== undefined && Math.abs(Number(digits)) >= Math.round(next.size / s.size)) {
      i += 1;
      continue;
    }
    return s.text === '' ? digits : `${digits}${space}${s.text}`;
  }
}

const SI: readonly Scale[] = ['', 'k', 'M', 'G', 'T', 'P'].map((text, i) => ({
  size: 1000 ** i,
  text,
}));
const IEC: readonly Scale[] = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'].map((text, i) => ({
  size: 1024 ** i,
  text,
}));
const TIME: readonly Scale[] = [
  { size: 1e-9, text: 'ns' },
  { size: 1e-6, text: 'µs' },
  { size: 1e-3, text: 'ms' },
  { size: 1, text: 's' },
  { size: 60, text: 'min' },
  { size: 3_600, text: 'h' },
  { size: 86_400, text: 'd' },
];
const TIME_BASE: Readonly<Record<'ns' | 'us' | 'ms' | 's', number>> = {
  ns: 1e-9,
  us: 1e-6,
  ms: 1e-3,
  s: 1,
};

/**
 * A chart value in its unit (VL-012, T08-027): `2.84 s`, `1.2k rps`, `38 %`, `1.5 GiB`. Three
 * significant digits; SI prefixes for plain numbers, IEC for bytes, the largest time unit whose
 * value is at least 1. `NaN` is `—`.
 */
export function formatValue(v: number, unit: Unit): string {
  if (Number.isNaN(v)) return '—';
  if (v === Infinity) return '+Inf';
  if (v === -Infinity) return '-Inf';
  if (v < 0) return `-${formatValue(-v, unit)}`;
  switch (unit.kind) {
    case 'none':
      return v < 1 ? sig(v) : scaled(v, SI, '');
    case 'suffix':
      return `${v < 1 ? sig(v) : scaled(v, SI, '')} ${unit.suffix}`;
    case 'bytes':
      return v < 1 ? `${sig(v)} B` : scaled(v, IEC, ' ');
    case 'percent':
      return `${sig(v)} %`;
    case 'percentunit':
      return `${sig(v * 100)} %`;
    case 'time': {
      const seconds = v * TIME_BASE[unit.base];
      if (seconds === 0) return '0 s';
      return scaled(seconds, TIME, ' ');
    }
  }
}

/** STUB (#93 tests first). */
export function formatCompact(_v: number, _unit: Unit): string {
  return '';
}

/** STUB (#93 tests first). */
export function compactSamples(_unit: Unit): readonly string[] {
  return [];
}

/** `14:05` in `tz`. */
export function formatHourMinute(ms: number, tz: string): string {
  return formatter('hourMinute', tz).format(ms);
}

/** `19 Nov` in `tz`. */
export function formatDayMonth(ms: number, tz: string): string {
  return formatter('dayMonth', tz).format(ms);
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
