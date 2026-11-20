// Stub for the tests-first commit: the implementation follows.
/**
 * Date and time formatting, locale en-GB (T08-027). The only module that creates `Intl` formatters;
 * they are cached per time zone.
 */
import type { ContextSearch, RefreshInterval } from '../state/contextSearch';

/** Stub (tests-first commit): any use throws. */
function notImplemented<T>(): T {
  const fail = (): never => {
    throw new Error('not implemented');
  };
  return new Proxy(fail, { get: fail, apply: fail, construct: fail, ownKeys: fail }) as T;
}

export function browserTimeZone(): string {
  throw new Error('not implemented');
}

export function formatDate(ms: number, tz: string): string {
  throw new Error('not implemented');
}

export function formatTime(ms: number, tz: string): string {
  throw new Error('not implemented');
}

export function formatRange(fromMs: number, toMs: number, tz: string): string {
  throw new Error('not implemented');
}

export function formatRangeShort(fromMs: number, toMs: number, tz: string): string {
  throw new Error('not implemented');
}

export function formatZone(tz: string, atMs: number): string {
  throw new Error('not implemented');
}

export const QUICK_RANGES: readonly [
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
] = notImplemented();

export type QuickRange = (typeof QUICK_RANGES)[number];

export function quickRangeLabel(q: QuickRange): string {
  throw new Error('not implemented');
}

export function quickRangeOf(s: ContextSearch): QuickRange | null {
  throw new Error('not implemented');
}

export function describeRange(s: ContextSearch, nowMs: number, tz: string): string {
  throw new Error('not implemented');
}

export function refreshLabel(r: RefreshInterval): string {
  throw new Error('not implemented');
}
