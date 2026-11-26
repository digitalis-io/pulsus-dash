/**
 * List snapshots (plan #216 Part 1 §3.6; T24-024, VIZ-027), shared by the board list and the change
 * feed: the rows of one answer under its query key, their coverage and when they were fetched.
 * The meter is `coverageText` over the coverage.
 */
import type { Coverage } from '../../data/frames';

export interface ListSnapshot<R> {
  /** The query key the rows were read under (tenant, source, effective filter). */
  readonly key: readonly unknown[];
  /** Every loaded row, in display order. */
  readonly rows: readonly R[];
  readonly coverage: Coverage;
  readonly fetchedAtMs: number;
}

/**
 * The coverage of a list: `total` the loaded rows, `drawn` the shown rows (at most the loaded),
 * the answer's truncation, nothing kept, no baseline; `staleAtMs` as given, and `unknown` only
 * when given. The meter then reads `showing X of N`, with the T22-006 list parts.
 */
export function listCoverage(
  loaded: number,
  shown: number,
  truncated: boolean,
  staleAtMs: number | null,
  unknown?: Coverage['unknown'],
): Coverage {
  return {
    total: loaded,
    drawn: Math.min(shown, loaded),
    keptMin: false,
    keptMax: false,
    keptWorst: 0,
    omittedWorst: 0,
    worstState: null,
    outside: 0,
    duplicates: 0,
    conflicts: 0,
    query: {
      truncated,
      warnings: [],
      infos: [],
      queryId: null,
      dataAgeMs: null,
      readCache: null,
      readCacheThroughMs: null,
    },
    baseline: null,
    ...(unknown === undefined ? {} : { unknown }),
    staleAtMs,
  };
}

/** A copy of `s` whose coverage is stale since `atMs` (a failed refetch keeps the rows). */
export function withStale<R>(s: ListSnapshot<R>, atMs: number): ListSnapshot<R> {
  return { ...s, coverage: { ...s.coverage, staleAtMs: atMs } };
}

/** `aria-setsize`: the loaded count, or −1 when the answer is truncated or its coverage unknown. */
export function listSetSize(s: ListSnapshot<unknown>): number {
  return s.coverage.query.truncated || s.coverage.unknown !== undefined ? -1 : s.rows.length;
}

export { csvCell } from '../../data/csv';
