/**
 * Time expressions of the time Context (IA-020, T03-014).
 *
 * Grammar (no whitespace anywhere):
 *   "now" | "now/d" | "now-" N UNIT | ISO
 *   N    = [1-9][0-9]{0,4}            (1 … 99 999)
 *   UNIT = s | m | h | d | w          (fixed durations; a day is always 24 h)
 *   ISO  = YYYY-MM-DDTHH:mm[:ss[.sss]](Z|±HH:MM), year 1970 … 9999
 *
 * `now/d` is the start of the current day in the given time zone.
 */
import { fromAbsolute, toCalendarDate, toZoned } from '@internationalized/date';
import { t } from '../i18n/t';

export type TimeUnit = 's' | 'm' | 'h' | 'd' | 'w';

export type TimeExpr =
  | { kind: 'now' }
  | { kind: 'startOfDay' }
  | { kind: 'ago'; n: number; unit: TimeUnit }
  | { kind: 'absolute'; ms: number };

export type TimeExprError =
  | { code: 'empty' }
  | { code: 'syntax' }
  | { code: 'badNumber' }
  | { code: 'outOfRange' }
  | { code: 'unknownUnit'; unit: string };

export type ParseResult = { ok: true; expr: TimeExpr } | { ok: false; error: TimeExprError };

export const UNIT_MS: Readonly<Record<TimeUnit, number>> = Object.freeze({
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
});

const MAX_N = 99_999;
const MIN_YEAR = 1970;
const MAX_YEAR = 9999;

const ISO =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/;

function fail(error: TimeExprError): ParseResult {
  return { ok: false, error };
}

function isUnit(u: string): u is TimeUnit {
  return u === 's' || u === 'm' || u === 'h' || u === 'd' || u === 'w';
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parseAgo(rest: string): ParseResult {
  const digits = /^[0-9]*/.exec(rest)?.[0] ?? '';
  const unit = rest.slice(digits.length);
  if (rest === '') return fail({ code: 'syntax' });
  if (digits === '') return fail({ code: 'badNumber' });
  if (unit === '' || !/^[A-Za-z]+$/.test(unit)) return fail({ code: 'syntax' });
  if (digits.length > 1 && digits.startsWith('0')) return fail({ code: 'badNumber' });
  const n = Number(digits);
  if (n === 0 || digits.length > 5 || n > MAX_N) return fail({ code: 'outOfRange' });
  if (!isUnit(unit)) return fail({ code: 'unknownUnit', unit });
  return { ok: true, expr: { kind: 'ago', n, unit } };
}

function parseIso(s: string): ParseResult {
  const m = ISO.exec(s);
  if (m === null) return fail({ code: 'syntax' });
  const num = (i: number): number => Number(m[i] ?? '0');
  const year = num(1);
  const month = num(2);
  const day = num(3);
  const hour = num(4);
  const minute = num(5);
  const second = num(6);
  const milli = num(7);
  if (month < 1 || month > 12) return fail({ code: 'syntax' });
  if (day < 1 || day > daysInMonth(year, month)) return fail({ code: 'syntax' });
  if (hour > 23 || minute > 59 || second > 59) return fail({ code: 'syntax' });
  let offsetMin = 0;
  if (m[8] !== 'Z') {
    const oh = num(10);
    const om = num(11);
    if (oh > 23 || om > 59) return fail({ code: 'syntax' });
    offsetMin = (m[9] === '-' ? -1 : 1) * (oh * 60 + om);
  }
  if (year < MIN_YEAR || year > MAX_YEAR) return fail({ code: 'outOfRange' });
  const ms = Date.UTC(year, month - 1, day, hour, minute, second, milli) - offsetMin * 60_000;
  // The instant itself must print as a year in range, so print∘parse always parses again.
  const utcYear = new Date(ms).getUTCFullYear();
  if (utcYear < MIN_YEAR || utcYear > MAX_YEAR) return fail({ code: 'outOfRange' });
  return { ok: true, expr: { kind: 'absolute', ms } };
}

export function parseTimeExpr(s: string): ParseResult {
  if (s === '') return fail({ code: 'empty' });
  if (s === 'now') return { ok: true, expr: { kind: 'now' } };
  if (s === 'now/d') return { ok: true, expr: { kind: 'startOfDay' } };
  if (s.startsWith('now-')) return parseAgo(s.slice(4));
  if (/^\d/.test(s)) return parseIso(s);
  return fail({ code: 'syntax' });
}

export function printTimeExpr(e: TimeExpr): string {
  switch (e.kind) {
    case 'now':
      return 'now';
    case 'startOfDay':
      return 'now/d';
    case 'ago':
      return `now-${String(e.n)}${e.unit}`;
    case 'absolute':
      return new Date(e.ms).toISOString();
  }
}

export function resolveTimeExpr(e: TimeExpr, nowMs: number, timeZone: string): number {
  switch (e.kind) {
    case 'now':
      return nowMs;
    case 'startOfDay':
      return toZoned(toCalendarDate(fromAbsolute(nowMs, timeZone)), timeZone)
        .toDate()
        .getTime();
    case 'ago':
      return nowMs - e.n * UNIT_MS[e.unit];
    case 'absolute':
      return e.ms;
  }
}

/** True when the expression is an absolute instant (prints as ISO-8601). */
export function isAbsolute(s: string): boolean {
  const r = parseTimeExpr(s);
  return r.ok && r.expr.kind === 'absolute';
}

/**
 * Resolves a canonical expression string; throws `RangeError` if it does not parse (callers pass
 * values that `contextSearch.ts` has already validated).
 */
export function resolveTimeString(s: string, nowMs: number, timeZone: string): number {
  const r = parseTimeExpr(s);
  if (!r.ok) throw new RangeError(`invalid time expression: ${s}`);
  return resolveTimeExpr(r.expr, nowMs, timeZone);
}

export function timeExprErrorMessage(e: TimeExprError): string {
  switch (e.code) {
    case 'empty':
      return t('timeExpr.empty');
    case 'syntax':
      return t('timeExpr.syntax');
    case 'badNumber':
      return t('timeExpr.badNumber');
    case 'outOfRange':
      return t('timeExpr.outOfRange');
    case 'unknownUnit':
      return t('timeExpr.unknownUnit', { unit: e.unit });
  }
}
