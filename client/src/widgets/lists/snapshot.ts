/** List snapshots (stub). */
import { EMPTY_COVERAGE, type Coverage } from '../../data/frames';

export interface ListSnapshot<R> {
  readonly key: readonly unknown[];
  readonly rows: readonly R[];
  readonly coverage: Coverage;
  readonly fetchedAtMs: number;
}

export function listCoverage(
  _loaded: number,
  _shown: number,
  _truncated: boolean,
  _staleAtMs: number | null,
  _unknown?: Coverage['unknown'],
): Coverage {
  return EMPTY_COVERAGE;
}

export function withStale<R>(s: ListSnapshot<R>, _atMs: number): ListSnapshot<R> {
  return s;
}

export function listSetSize(s: ListSnapshot<unknown>): number {
  return s.rows.length;
}

export { csvCell } from '../../data/csv';
