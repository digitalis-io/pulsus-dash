// Stub for the tests-first commit: the implementation follows.
/**
 * The only reader and writer of the time Context keys `from`, `to` and `refresh` in the URL search
 * (IA-022, T08-005, ADR-0017). Every other module goes through `useTimeContext()`; ESLint bans
 * `useSearchParams` and `createSearchParams` outside `src/state/`.
 *
 * Reading validates, defaults and canonicalises; writing emits the canonical form, so a canonical
 * URL reads back to the same value and writes back to the same string.
 */
import { type TimeExprError } from './timeExpr';

/** Stub (tests-first commit): any use throws. */
function notImplemented<T>(): T {
  const fail = (): never => {
    throw new Error('not implemented');
  };
  return new Proxy(fail, { get: fail, apply: fail, construct: fail, ownKeys: fail }) as T;
}

export const CONTEXT_KEYS: readonly ['from', 'to', 'refresh'] = notImplemented();

export type ContextKey = (typeof CONTEXT_KEYS)[number];

export const REFRESH_INTERVALS: readonly ['off', '10s', '30s', '1m', '5m', '15m'] =
  notImplemented();

export type RefreshInterval = (typeof REFRESH_INTERVALS)[number];

/** Canonical Context: `from` and `to` are their own `printTimeExpr` re-print. */
export interface ContextSearch {
  readonly from: string;
  readonly to: string;
  readonly refresh: RefreshInterval;
}

export const DEFAULT_CONTEXT: ContextSearch = notImplemented();

export type SearchParamPair = readonly [key: string, value: string];

export type SearchIssue =
  | {
      key: ContextKey;
      code: 'missing';
    }
  | {
      key: ContextKey;
      code: 'duplicate';
    }
  | {
      key: 'from' | 'to';
      code: 'invalid';
      error: TimeExprError;
    }
  | {
      key: 'refresh';
      code: 'invalid';
      value: string;
    }
  | {
      key: 'to';
      code: 'notAfterFrom';
    };

export interface SearchEnv {
  nowMs: number;
  timeZone: string;
}

export function isRefreshInterval(v: string): v is RefreshInterval {
  throw new Error('not implemented');
}

export function readContextSearch(
  p: URLSearchParams,
  env: SearchEnv,
): {
  search: ContextSearch;
  rest: readonly SearchParamPair[];
  issues: readonly SearchIssue[];
} {
  throw new Error('not implemented');
}

export function writeContextSearch(
  s: ContextSearch,
  rest?: readonly SearchParamPair[],
): URLSearchParams {
  throw new Error('not implemented');
}

export function contextSearchString(s: ContextSearch, rest?: readonly SearchParamPair[]): string {
  throw new Error('not implemented');
}

export function normalisedSearch(search: string, env: SearchEnv): string | null {
  throw new Error('not implemented');
}

export function refreshMs(r: RefreshInterval): number | null {
  throw new Error('not implemented');
}
