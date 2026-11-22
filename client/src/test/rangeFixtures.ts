/** Range results for the board panel tests (plan #64 A.15). */
import type { Completeness, PlannedQuery, RangeResult } from '../data/decode';
import type { SeriesFrame } from '../data/frames';
import { keyHash } from '../dev/keyHash';

/** 12:00 of `ABS`. */
export const T0 = Date.UTC(2026, 10, 19, 12);

export const C0: Completeness = {
  truncated: false,
  warnings: [],
  infos: [],
  queryId: null,
  dataAgeMs: null,
  readCache: null,
  readCacheThroughMs: null,
};

function series(labels: Record<string, string>, values: readonly number[]): SeriesFrame {
  return {
    key: keyHash(labels),
    labels,
    timestamps: Float64Array.of(T0, T0 + 5_000, T0 + 10_000),
    values: Float64Array.from(values),
  };
}

function result(planned: PlannedQuery, s: readonly SeriesFrame[]): RangeResult {
  return { planned, startMs: T0, endMs: T0 + 10_000, stepMs: 5_000, series: s, completeness: C0 };
}

const E = 'sum by (le) (rate(http_request_duration_seconds_bucket[5m]))';
const G = 'node_memory_free_bytes';

const facts = (query: string, bytes: number, histogram: boolean): PlannedQuery => ({
  query,
  expanded: query,
  bytes,
  valueType: 'vector',
  rateCandidate: false,
  rateApplied: false,
  histogram,
  stepMs: 5000,
});

export const R_H1: RangeResult = result(facts(E, 60, true), [
  series({ le: '0.1' }, [1, 1, 1]),
  series({ le: '0.5' }, [3, 3, 3]),
  series({ le: '+Inf' }, [4, 4, 4]),
]);

export const R_A: RangeResult = result(facts(G, 22, false), [
  series({ __name__: G, instance: 'a' }, [1, 2, 3]),
]);

export const R_B: RangeResult = result(facts(G, 22, false), [
  series({ __name__: G, instance: 'a' }, [10, 20, 30]),
]);
