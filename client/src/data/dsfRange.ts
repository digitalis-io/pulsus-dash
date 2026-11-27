/**
 * A range result from the engine's decoded message (plan #68 D2 §3.4): the same `RangeResult` the
 * JSON path's `decodeRange` builds, and the `ApiError` of an `error/1` row.
 */
import { ApiError } from '../api/types';
import type { DecodedRange, WireCoverage, WireErrorRow } from '../api/rangeDecoder';
import type { RangeResult } from './decode';

const EMPTY = {
  truncated: false,
  warnings: [],
  infos: [],
  queryId: null,
  dataAgeMs: null,
  readCache: null,
  readCacheThroughMs: null,
} as const;

export function rangeFromDecoded(m: DecodedRange, receivedAtMs: number): RangeResult {
  void receivedAtMs;
  return {
    startMs: m.head.startMs,
    endMs: m.head.endMs,
    stepMs: m.head.stepMs,
    series: [],
    completeness: EMPTY,
    planned: {
      query: '',
      expanded: '',
      bytes: 0,
      valueType: 'unknown',
      rateCandidate: false,
      rateApplied: false,
      histogram: false,
    },
  };
}

export function errorFromRow(
  row: WireErrorRow,
  coverage: WireCoverage | null,
  plannedJson: string | null,
): ApiError {
  void coverage;
  void plannedJson;
  return new ApiError('unknown', row.message);
}
