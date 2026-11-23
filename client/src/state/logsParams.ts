/**
 * The Explore › Logs keys of the URL search (IA-022, plan #66 Part C §3.1): `q` (the LogQL query),
 * `dir` (`forward` = oldest first; absent = newest first) and `wrap` (`on` wraps the lines). With
 * `contextSearch.ts` this is the only reader and writer of these keys (ADR-0017). Reading defaults
 * and canonicalises; writing omits default values and keeps every pair sorted by key.
 */
import type { SearchEnv, SearchParamPair } from './contextSearch';

export interface LogsParams {
  readonly q: string;
  /** `dir=forward` in the URL; absent or any other value = newest first. */
  readonly dir: 'backward' | 'forward';
  /** `wrap=on` in the URL; absent or any other value = off. */
  readonly wrap: boolean;
}

export const DEFAULT_LOGS: LogsParams = Object.freeze({ q: '', dir: 'backward', wrap: false });

/** First value of each key, as `readExploreParams`. */
export function readLogsParams(_rest: readonly SearchParamPair[]): LogsParams {
  throw new Error('not implemented');
}

/** `rest` without `q`, `dir`, `wrap`, plus the non-default keys, sorted by key (stable, UTF-16). */
export function writeLogsParams(
  _rest: readonly SearchParamPair[],
  _p: LogsParams,
): SearchParamPair[] {
  throw new Error('not implemented');
}

/** The canonical search, or null when `search` is canonical. */
export function normalisedLogsSearch(_search: string, _env: SearchEnv): string | null {
  throw new Error('not implemented');
}
