/**
 * The `ApiError` of a failed query (plan #62 §4.5, plan #112 §3.8), from the status and the error
 * envelope: the one mapping of the JSON path and, plan #68 D2 §3.4, of an `error/1` row rebuilt
 * into the envelope the same class has before the header (`data/dsfRange.ts`).
 */
import {
  DecodeError,
  decodePlanned,
  type LogqlPlannedQuery,
  type PlannedQuery,
} from '../data/decode';
import type { components } from './gen/schema';
import { ApiError, type ApiErrorDetail } from './types';

type ErrorEnvelope = components['schemas']['ErrorEnvelope'];
type ErrorBody = Partial<components['schemas']['ErrorBody']>;

/** The envelope's message, else `HTTP <status>`. */
export function messageOf(error: unknown, status: number): string {
  const msg = (error as Partial<ErrorEnvelope> | undefined)?.error?.message;
  return typeof msg === 'string' && msg !== '' ? msg : `HTTP ${String(status)}`;
}

function isRecord(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The decoder of an error body's `planned`: the PromQL or the LogQL plan (plan #116 §3.8). */
export type PlannedDecoder = (v: unknown, path: string) => PlannedQuery | LogqlPlannedQuery;

/** The error body's `planned`, decoded; absent when missing or malformed (plan #112 §3.8). */
function plannedOf(
  body: ErrorBody,
  decode: PlannedDecoder,
): PlannedQuery | LogqlPlannedQuery | undefined {
  if (body.planned === undefined) return undefined;
  try {
    return decode(body.planned, '/planned');
  } catch (e) {
    if (e instanceof DecodeError) return undefined;
    throw e;
  }
}

const TOO_LONG_KEYS = new Set(['query.sent_too_large', 'query.too_large_to_plan']);

/**
 * The `ApiError` of a failed query or check (plan #62 §4.5, plan #112 §3.8): every `detail` carries
 * the server's `planned` when the body has one (errors raised after planning), decoded by `decode`
 * (the LogQL routes pass `decodeLogqlPlanned`, plan #116 §3.8).
 */
export function queryError(
  status: number,
  error: unknown,
  decode: PlannedDecoder = decodePlanned,
): ApiError {
  const body: ErrorBody = (error as Partial<ErrorEnvelope> | undefined)?.error ?? {};
  const message = messageOf(error, status);
  const hint = isRecord(body.hint) ? body.hint : undefined;
  const planned = plannedOf(body, decode);
  const fields = body.fields ?? [];
  const queryId = typeof body.query_id === 'string' ? body.query_id : undefined;
  const detail = (extra: ApiErrorDetail = {}): ApiErrorDetail => ({
    ...extra,
    ...(planned === undefined ? {} : { planned }),
  });
  const withHint = detail(hint === undefined ? {} : { hint });
  if (status === 413 && fields.some((f) => TOO_LONG_KEYS.has(f.message_key))) {
    return new ApiError('queryTooLong', message, {
      detail: detail({
        ...(hint === undefined ? {} : { hint }),
        ...(queryId === undefined ? {} : { queryId }),
      }),
    });
  }
  if (
    status === 400 &&
    fields.some(
      (f) =>
        f.message_key === 'variable.missing' ||
        f.pointer === '/step_ms' ||
        f.pointer.startsWith('/vars'),
    )
  ) {
    return new ApiError('invalid', message, {
      fields: fields.map((f) => ({ pointer: f.pointer, messageKey: f.message_key })),
      detail: detail(),
    });
  }
  if (status === 400 && body.code === 'virtual_unsupported') {
    return new ApiError('queryInvalid', message, { detail: withHint });
  }
  if (status === 400 && fields[0]?.pointer === '/query') {
    const d: ApiErrorDetail = {};
    const position = isRecord(hint?.['position']) ? hint['position']['offset'] : undefined;
    if (typeof position === 'number') d.position = position;
    if (queryId !== undefined) d.queryId = queryId;
    return new ApiError('queryInvalid', message, { detail: detail(d) });
  }
  switch (status) {
    case 404:
      return new ApiError('notFound', message, { detail: detail() });
    case 422:
      return new ApiError('tooBroad', message, { detail: withHint });
    case 429:
      return new ApiError('busy', message, { detail: withHint });
    case 502:
    case 503:
      return new ApiError('unavailable', message, { detail: withHint });
    case 504:
      return new ApiError('timeout', message, { detail: detail() });
  }
  return new ApiError('unknown', message, { detail: detail() });
}
