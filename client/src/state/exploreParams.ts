/**
 * The Explore keys of the URL search (IA-022, plan #63 §3.5): `q` (the query), `vis` (an override
 * of the auto vis) and `rate` (`off` turns the rate rewrite off). With `contextSearch.ts` this is
 * the only reader and writer of these keys (ADR-0017). Reading defaults and canonicalises; writing
 * omits default values and keeps every pair sorted by key, as `readContextSearch` sorts the rest.
 */
import type { VisParam } from '../vis/autovis';
import {
  contextSearchString,
  readContextSearch,
  type SearchEnv,
  type SearchParamPair,
} from './contextSearch';

export interface ExploreParams {
  readonly q: string;
  readonly vis: VisParam;
  readonly rate: 'auto' | 'off';
}

export const DEFAULT_EXPLORE: ExploreParams = Object.freeze({ q: '', vis: 'auto', rate: 'auto' });

const EXPLORE_KEYS: readonly string[] = ['q', 'vis', 'rate'];
const VIS_VALUES: readonly string[] = ['line', 'bars', 'heatmap', 'stat'];

function isVis(v: string): v is Exclude<VisParam, 'auto'> {
  return VIS_VALUES.includes(v);
}

/** `q`: the first value; `vis`: the first valid value, else `auto`; `rate`: `off` if the first value is. */
export function readExploreParams(rest: readonly SearchParamPair[]): ExploreParams {
  const values = (key: string) => rest.filter(([k]) => k === key).map(([, v]) => v);
  const vis = values('vis').find(isVis) ?? 'auto';
  return {
    q: values('q')[0] ?? DEFAULT_EXPLORE.q,
    vis,
    rate: values('rate')[0] === 'off' ? 'off' : 'auto',
  };
}

/** `rest` without its explore pairs, plus `p`'s non-default keys, sorted by key (stable). */
export function writeExploreParams(
  rest: readonly SearchParamPair[],
  p: ExploreParams,
): SearchParamPair[] {
  const out: SearchParamPair[] = rest.filter(([k]) => !EXPLORE_KEYS.includes(k));
  if (p.q !== '') out.push(['q', p.q]);
  if (p.vis !== 'auto') out.push(['vis', p.vis]);
  if (p.rate === 'off') out.push(['rate', 'off']);
  // Array.prototype.sort is stable; `<` compares UTF-16 code units, as `readContextSearch`.
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** The canonical search for `search` with its explore keys, or `null` when it is canonical. */
export function normalisedExploreSearch(search: string, env: SearchEnv): string | null {
  const r = readContextSearch(new URLSearchParams(search), env);
  const c = contextSearchString(r.search, writeExploreParams(r.rest, readExploreParams(r.rest)));
  return c === search ? null : c;
}
