/**
 * A range result from the engine's decoded message (plan #68 D2 §3.4): the same `RangeResult` the
 * JSON path's `decodeRange` builds from the same request, and the `ApiError` of an `error/1` row.
 * The data is never parsed here: the engine decoded it on the pool; only the planned object (a few
 * hundred bytes, `dash.planned`) is parsed and validated, by the JSON path's own `decodePlanned`.
 *
 * | `RangeResult` field | From |
 * |---|---|
 * | `startMs`, `endMs`, `stepMs` | the head |
 * | `series[i]` | the head's key and labels; `timestamps`: the one shared `ts`; `values`: `vs[i]` |
 * | `planned` | `decodePlanned(JSON.parse(head.planned), '/planned')`; missing, unparsable or refused → `DecodeError` |
 * | `completeness` | the final `coverage/1` row: `truncated`, `warnings` (and the truncation reason), `infos`, `queryId` = `upstream_query_ids[0]`, `readCache`, `readCacheThroughMs`, `dataAgeMs` from `data_end` |
 */
import type { DecodedRange, WireCoverage, WireErrorRow } from '../api/rangeDecoder';
import { queryError } from '../api/queryError';
import type { ApiError } from '../api/types';
import { DecodeError, decodePlanned, type Completeness, type RangeResult } from './decode';
import type { SeriesFrame } from './frames';

const READ_CACHE = ['hit', 'miss', 'bypass', 'other'] as const;

/** The completeness of the final coverage row; `dataAgeMs` = receipt − `data_end`, at least 0. */
function completeness(c: WireCoverage, receivedAtMs: number): Completeness {
  const reason = c.truncation_reason;
  const warnings =
    c.truncated && reason !== null && !c.warnings.includes(reason)
      ? [...c.warnings, reason]
      : [...c.warnings];
  return {
    truncated: c.truncated,
    warnings,
    infos: [...c.infos],
    queryId: c.upstream_query_ids[0] ?? null,
    dataAgeMs: c.data_end === null ? null : Math.max(0, receivedAtMs - c.data_end),
    readCache: c.read_cache === null ? null : (READ_CACHE[c.read_cache] ?? 'other'),
    readCacheThroughMs: c.read_cache_through,
  };
}

/** `dash.planned` as the JSON path's `PlannedQuery`; a `DecodeError` when missing or invalid. */
function planned(text: string | null) {
  if (text === null) throw new DecodeError('/planned', 'dash.planned is missing');
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new DecodeError('/planned', 'dash.planned is not JSON');
  }
  return decodePlanned(v, '/planned');
}

/** The `RangeResult` of a decoded message (§3.4); a `DecodeError` for invalid metadata. */
export function rangeFromDecoded(m: DecodedRange, receivedAtMs: number): RangeResult {
  const h = m.head;
  const p = planned(h.planned);
  if (h.coverage === null) throw new DecodeError('/completeness', 'no coverage row');
  if (m.vs.length !== h.series.length) {
    throw new DecodeError('/frames', 'series and values differ in count');
  }
  const series: SeriesFrame[] = h.series.map((s, i) => {
    const values = m.vs[i] ?? new Float64Array(0);
    if (values.length !== m.ts.length) {
      throw new DecodeError(`/frames/${String(i)}/values`, 'not the grid length');
    }
    return { key: s.key, labels: s.labels, timestamps: m.ts, values };
  });
  const absent = m.absent;
  if (absent !== undefined && absent.length !== series.length) {
    throw new DecodeError('/frames', 'series and absent masks differ in count');
  }
  return {
    planned: p,
    startMs: h.startMs,
    endMs: h.endMs,
    stepMs: h.stepMs,
    series,
    completeness: completeness(h.coverage, receivedAtMs),
    // The validity bitmap's null slots (#304 §A.3); none absent: no member, as the JSON path.
    ...(absent !== undefined && absent.some((a) => a !== null) ? { absent: [...absent] } : {}),
  };
}

/**
 * The `ApiError` of an `error/1` row (§3.4): the envelope D1 gives the same class before the
 * header, rebuilt, through the JSON path's `queryError`. `hint.reason` is not carried (no client
 * code reads it), nor is the retry (no `ApiError` member exposes one).
 *
 * | Code | Envelope |
 * |---|---|
 * | 0 bad_query | `invalid`, field `/query` (`query.invalid`), `hint.position.offset` from the row |
 * | 1 too_broad | `too_broad`, `hint.action: 'narrow'` |
 * | 3 forbidden_scope | `scope_denied` |
 * | 4 upstream_unavailable | `unavailable` |
 * | 5 timeout | `unavailable`, `hint.action: 'narrow'` |
 * | 7 rate_limited | `budget_exhausted` |
 * | 8 internal, other | `internal` |
 */
export function errorFromRow(
  row: WireErrorRow,
  coverage: WireCoverage | null,
  plannedJson: string | null,
): ApiError {
  const queryId = coverage?.upstream_query_ids[0];
  let plannedObj: unknown;
  if (plannedJson !== null) {
    try {
      plannedObj = JSON.parse(plannedJson);
    } catch {
      plannedObj = undefined;
    }
  }
  const narrow = row.code === 1 || row.code === 5 || row.suggestion === 'narrow';
  const code =
    row.code === 0
      ? 'invalid'
      : row.code === 1
        ? 'too_broad'
        : row.code === 3
          ? 'scope_denied'
          : row.code === 4 || row.code === 5
            ? 'unavailable'
            : row.code === 7
              ? 'budget_exhausted'
              : 'internal';
  const hint: Record<string, unknown> = {
    ...(narrow ? { action: 'narrow' } : {}),
    ...(row.code === 0 && row.position !== null ? { position: { offset: row.position } } : {}),
  };
  const error = {
    code,
    message: row.message,
    ...(row.code === 0 ? { fields: [{ pointer: '/query', message_key: 'query.invalid' }] } : {}),
    ...(Object.keys(hint).length === 0 ? {} : { hint }),
    ...(queryId === undefined ? {} : { query_id: queryId }),
    ...(plannedObj === undefined ? {} : { planned: plannedObj }),
  };
  return queryError(row.http_status, { error });
}
