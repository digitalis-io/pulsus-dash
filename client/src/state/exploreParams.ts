/** Stub (tests first, plan #63 §5). */
import type { SearchEnv, SearchParamPair } from './contextSearch';
import type { VisParam } from '../vis/autovis';

export interface ExploreParams {
  readonly q: string;
  readonly vis: VisParam;
  readonly rate: 'auto' | 'off';
}

export const DEFAULT_EXPLORE: ExploreParams = Object.freeze({ q: '', vis: 'auto', rate: 'auto' });

export function readExploreParams(_rest: readonly SearchParamPair[]): ExploreParams {
  return DEFAULT_EXPLORE;
}

export function writeExploreParams(
  rest: readonly SearchParamPair[],
  _p: ExploreParams,
): SearchParamPair[] {
  return [...rest];
}

export function normalisedExploreSearch(_search: string, _env: SearchEnv): string | null {
  return null;
}
