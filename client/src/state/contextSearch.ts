/**
 * The only reader and writer of the time Context keys `from`, `to` and `refresh` in the URL search
 * (IA-022, T08-005, ADR-0017). Every other module goes through `useTimeContext()`; ESLint bans
 * `useSearchParams` and `createSearchParams` outside `src/state/`.
 *
 * Reading validates, defaults and canonicalises; writing emits the canonical form, so a canonical
 * URL reads back to the same value and writes back to the same string.
 */
import {
  parseTimeExpr,
  printTimeExpr,
  resolveTimeExpr,
  type TimeExpr,
  type TimeExprError,
} from './timeExpr';

export const CONTEXT_KEYS = ['from', 'to', 'refresh'] as const;
export type ContextKey = (typeof CONTEXT_KEYS)[number];

export const REFRESH_INTERVALS = ['off', '10s', '30s', '1m', '5m', '15m'] as const;
export type RefreshInterval = (typeof REFRESH_INTERVALS)[number];

/** Canonical Context: `from` and `to` are their own `printTimeExpr` re-print. */
export interface ContextSearch {
  readonly from: string;
  readonly to: string;
  readonly refresh: RefreshInterval;
}

export const DEFAULT_CONTEXT: ContextSearch = Object.freeze({
  from: 'now-1h',
  to: 'now',
  refresh: 'off',
});

export type SearchParamPair = readonly [key: string, value: string];

export type SearchIssue =
  | { key: ContextKey; code: 'missing' }
  | { key: ContextKey; code: 'duplicate' }
  | { key: 'from' | 'to'; code: 'invalid'; error: TimeExprError }
  | { key: 'refresh'; code: 'invalid'; value: string }
  | { key: 'to'; code: 'notAfterFrom' };

export interface SearchEnv {
  nowMs: number;
  timeZone: string;
}

const REFRESH_MS: Readonly<Record<RefreshInterval, number | null>> = Object.freeze({
  off: null,
  '10s': 10_000,
  '30s': 30_000,
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
});

function isContextKey(k: string): k is ContextKey {
  return (CONTEXT_KEYS as readonly string[]).includes(k);
}

export function isRefreshInterval(v: string): v is RefreshInterval {
  return (REFRESH_INTERVALS as readonly string[]).includes(v);
}

export function readContextSearch(
  p: URLSearchParams,
  env: SearchEnv,
): { search: ContextSearch; rest: readonly SearchParamPair[]; issues: readonly SearchIssue[] } {
  const issues: SearchIssue[] = [];

  const first = (key: ContextKey): string | undefined => {
    const all = p.getAll(key);
    if (all.length === 0) {
      issues.push({ key, code: 'missing' });
      return undefined;
    }
    if (all.length > 1) issues.push({ key, code: 'duplicate' });
    return all[0];
  };

  const readTime = (key: 'from' | 'to'): { text: string; expr: TimeExpr } => {
    const fallback = DEFAULT_CONTEXT[key];
    const raw = first(key);
    if (raw !== undefined) {
      // A literal `+` decodes as a space under form encoding; the grammar has no whitespace.
      const r = parseTimeExpr(raw.replaceAll(' ', '+'));
      if (r.ok) return { text: printTimeExpr(r.expr), expr: r.expr };
      issues.push({ key, code: 'invalid', error: r.error });
    }
    const d = parseTimeExpr(fallback);
    if (!d.ok) throw new RangeError('default context does not parse');
    return { text: fallback, expr: d.expr };
  };

  let from = readTime('from');
  let to = readTime('to');

  let refresh: RefreshInterval = DEFAULT_CONTEXT.refresh;
  const rawRefresh = first('refresh');
  if (rawRefresh !== undefined) {
    if (isRefreshInterval(rawRefresh)) refresh = rawRefresh;
    else issues.push({ key: 'refresh', code: 'invalid', value: rawRefresh });
  }

  const fromMs = resolveTimeExpr(from.expr, env.nowMs, env.timeZone);
  const toMs = resolveTimeExpr(to.expr, env.nowMs, env.timeZone);
  if (fromMs >= toMs) {
    issues.push({ key: 'to', code: 'notAfterFrom' });
    from = { text: DEFAULT_CONTEXT.from, expr: { kind: 'ago', n: 1, unit: 'h' } };
    to = { text: DEFAULT_CONTEXT.to, expr: { kind: 'now' } };
  }

  const rest: SearchParamPair[] = [];
  for (const [k, v] of p) if (!isContextKey(k)) rest.push([k, v]);
  // Array.prototype.sort is stable; `<` compares UTF-16 code units.
  rest.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  return { search: { from: from.text, to: to.text, refresh }, rest, issues };
}

function assertCanonical(key: 'from' | 'to', value: string): void {
  const r = parseTimeExpr(value);
  if (!r.ok || printTimeExpr(r.expr) !== value) {
    throw new RangeError(`${key} is not canonical: ${value}`);
  }
}

export function writeContextSearch(
  s: ContextSearch,
  rest: readonly SearchParamPair[] = [],
): URLSearchParams {
  assertCanonical('from', s.from);
  assertCanonical('to', s.to);
  const p = new URLSearchParams();
  p.append('from', s.from);
  p.append('to', s.to);
  p.append('refresh', s.refresh);
  for (const [k, v] of rest) p.append(k, v);
  return p;
}

export function contextSearchString(s: ContextSearch, rest?: readonly SearchParamPair[]): string {
  return `?${writeContextSearch(s, rest).toString()}`;
}

/** The canonical search for `search`, or `null` when `search` is already canonical. */
export function normalisedSearch(search: string, env: SearchEnv): string | null {
  const r = readContextSearch(new URLSearchParams(search), env);
  const c = contextSearchString(r.search, r.rest);
  return search === c ? null : c;
}

export function refreshMs(r: RefreshInterval): number | null {
  return REFRESH_MS[r];
}
