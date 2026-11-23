/**
 * The Explore › Logs keys of the URL search (IA-022, plan #66 Part C §3.1): `q` (the LogQL query),
 * `dir` (`forward` = oldest first; absent = newest first) and `wrap` (`on` wraps the lines). With
 * `contextSearch.ts` this is the only reader and writer of these keys (ADR-0017). Reading defaults
 * and canonicalises; writing omits default values and keeps every pair sorted by key.
 */
import {
  contextSearchString,
  readContextSearch,
  type SearchEnv,
  type SearchParamPair,
} from './contextSearch';

export interface LogsParams {
  readonly q: string;
  /** `dir=forward` in the URL; absent or any other value = newest first. */
  readonly dir: 'backward' | 'forward';
  /** `wrap=on` in the URL; absent or any other value = off. */
  readonly wrap: boolean;
}

export const DEFAULT_LOGS: LogsParams = Object.freeze({ q: '', dir: 'backward', wrap: false });

const LOGS_KEYS: readonly string[] = ['q', 'dir', 'wrap'];

/** First value of each key, as `readExploreParams`. */
export function readLogsParams(rest: readonly SearchParamPair[]): LogsParams {
  const first = (key: string) => rest.find(([k]) => k === key)?.[1];
  return {
    q: first('q') ?? DEFAULT_LOGS.q,
    dir: first('dir') === 'forward' ? 'forward' : 'backward',
    wrap: first('wrap') === 'on',
  };
}

/** `rest` without `q`, `dir`, `wrap`, plus the non-default keys, sorted by key (stable, UTF-16). */
export function writeLogsParams(
  rest: readonly SearchParamPair[],
  p: LogsParams,
): SearchParamPair[] {
  const out: SearchParamPair[] = rest.filter(([k]) => !LOGS_KEYS.includes(k));
  if (p.q !== '') out.push(['q', p.q]);
  if (p.dir === 'forward') out.push(['dir', 'forward']);
  if (p.wrap) out.push(['wrap', 'on']);
  // Array.prototype.sort is stable; `<` compares UTF-16 code units, as `readContextSearch`.
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** The canonical search, or null when `search` is canonical. */
export function normalisedLogsSearch(search: string, env: SearchEnv): string | null {
  const r = readContextSearch(new URLSearchParams(search), env);
  const c = contextSearchString(r.search, writeLogsParams(r.rest, readLogsParams(r.rest)));
  return c === search ? null : c;
}
