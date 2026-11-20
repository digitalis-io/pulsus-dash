/**
 * The BFF client (ADR-0014 §1, ADR-0015): `openapi-fetch` over the types generated from
 * `api/openapi.yaml`. The session comes from `GET /api/dash/v1/bootstrap`. There is no boards API
 * until #61, so the board lists are empty and a board is not found. Query responses are decoded
 * at the one seam, `data/decode.ts`; failures map to `ApiError` kinds (plan #62 §4.5).
 */
import createClient, { type Client } from 'openapi-fetch';
import type { Api } from './Api';
import type { components, paths } from './gen/schema';
import {
  DecodeError,
  decodeInstant,
  decodeRange,
  type InstantResult,
  type RangeResult,
} from '../data/decode';
import {
  ApiError,
  type ApiErrorDetail,
  type BoardSummary,
  type DataSourceStatus,
  type InstantRequest,
  type RangeRequest,
  type Session,
} from './types';

type Bootstrap = components['schemas']['Bootstrap'];
type ErrorEnvelope = components['schemas']['ErrorEnvelope'];

/** An abort from fetch: a DOMException, which is not an Error subclass in every runtime. */
function isAbort(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'name' in e && e.name === 'AbortError';
}

function toSession(b: Bootstrap): Session {
  return {
    user: {
      id: b.principal.id,
      name: b.principal.name,
      email: b.principal.email,
      role: b.principal.role,
    },
    org: { name: b.org.name },
    tenants: b.tenants.map((t) => ({
      slug: t.slug,
      name: t.name,
      dataSource: { state: 'notChecked' },
    })),
    defaultTenant: b.default_tenant,
    server: { version: b.server.version, commit: b.server.commit },
    canSignOut: b.can_sign_out,
  };
}

/** The envelope's message, else `HTTP <status>`. */
function messageOf(error: unknown, status: number): string {
  const msg = (error as Partial<ErrorEnvelope> | undefined)?.error?.message;
  return typeof msg === 'string' && msg !== '' ? msg : `HTTP ${String(status)}`;
}

type ErrorBody = Partial<components['schemas']['ErrorBody']>;
// The generated request types make timeout_ms required because it has a default (the generator's
// default-non-nullable rule); the BFF applies the default, so the client omits it when unset.
type RangeBody = components['schemas']['PromRangeRequest'];
type InstantBody = components['schemas']['PromInstantRequest'];

function isRecord(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The `ApiError` of a failed query or check (plan #62 §4.5). */
function queryError(status: number, error: unknown): ApiError {
  const body: ErrorBody = (error as Partial<ErrorEnvelope> | undefined)?.error ?? {};
  const message = messageOf(error, status);
  const hint = isRecord(body.hint) ? body.hint : undefined;
  const withHint: ApiErrorDetail = hint === undefined ? {} : { hint };
  if (status === 400 && body.code === 'virtual_unsupported') {
    return new ApiError('queryInvalid', message, withHint);
  }
  if (status === 400 && body.fields?.[0]?.pointer === '/query') {
    const detail: ApiErrorDetail = {};
    const position = isRecord(hint?.['position']) ? hint['position']['offset'] : undefined;
    if (typeof position === 'number') detail.position = position;
    if (typeof body.query_id === 'string') detail.queryId = body.query_id;
    return new ApiError('queryInvalid', message, detail);
  }
  switch (status) {
    case 404:
      return new ApiError('notFound', message);
    case 422:
      return new ApiError('tooBroad', message, withHint);
    case 429:
      return new ApiError('busy', message);
    case 502:
    case 503:
      return new ApiError('unavailable', message, withHint);
    case 504:
      return new ApiError('timeout', message);
  }
  return new ApiError('unknown', message);
}

/** Runs a request: an abort is re-thrown unchanged, any other rejection is `network`. */
async function send<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (isAbort(e)) throw e;
    throw new ApiError('network', 'the BFF could not be reached');
  }
}

/** Decodes a 200 body; a body the decoder refuses is `badResponse`. */
function decoded<T>(decode: (b: unknown) => T, body: unknown): T {
  try {
    return decode(body);
  } catch (e) {
    if (e instanceof DecodeError) {
      throw new ApiError('badResponse', `${e.message} at ${e.path === '' ? '/' : e.path}`);
    }
    throw e;
  }
}

const DATA_SOURCE_STATES = {
  not_checked: 'notChecked',
  ok: 'ok',
  unreachable: 'unreachable',
  unauthorised: 'unauthorised',
  error: 'error',
} as const;

export class HttpApi implements Api {
  constructor(private readonly client: Client<paths> = createClient<paths>({ baseUrl: '' })) {}

  async getSession(signal?: AbortSignal): Promise<Session> {
    let result;
    try {
      result = await this.client.GET(
        '/api/dash/v1/bootstrap',
        signal === undefined ? {} : { signal },
      );
    } catch (e) {
      if (isAbort(e)) throw e;
      throw new ApiError('network', 'the BFF could not be reached');
    }
    const { data, error, response } = result;
    if (response.status === 404) throw new ApiError('notFound', messageOf(error, 404));
    if (data === undefined) throw new ApiError('unknown', messageOf(error, response.status));
    return toSession(data);
  }

  listBoards(): Promise<BoardSummary[]> {
    return Promise.resolve([]);
  }

  getBoard(_tenant: string, uid: string): Promise<BoardSummary> {
    return Promise.reject(new ApiError('notFound', `board ${uid} not found`));
  }

  listStarred(): Promise<string[]> {
    return Promise.resolve([]);
  }

  setStarred(): Promise<string[]> {
    return Promise.reject(new ApiError('notImplemented', 'starring boards arrives with #61'));
  }

  /** Never offered: `canSignOut` is false under the fixed local principal (D12). */
  signOut(): Promise<void> {
    return Promise.resolve();
  }

  async queryRange(tenant: string, req: RangeRequest, signal?: AbortSignal): Promise<RangeResult> {
    const body = {
      query: req.query,
      from: req.fromMs,
      to: req.toMs,
      width_px: req.widthPx,
      ...(req.timeoutMs === undefined ? {} : { timeout_ms: req.timeoutMs }),
    } as RangeBody;
    const { data, error, response } = await send(() =>
      this.client.POST('/api/dash/v1/query/promql/range', {
        params: { query: { tenant } },
        body,
        ...(signal === undefined ? {} : { signal }),
      }),
    );
    if (data === undefined) throw queryError(response.status, error);
    return decoded(decodeRange, data);
  }

  async queryInstant(
    tenant: string,
    req: InstantRequest,
    signal?: AbortSignal,
  ): Promise<InstantResult> {
    const body = {
      query: req.query,
      at: req.atMs,
      ...(req.timeoutMs === undefined ? {} : { timeout_ms: req.timeoutMs }),
    } as InstantBody;
    const { data, error, response } = await send(() =>
      this.client.POST('/api/dash/v1/query/promql/instant', {
        params: { query: { tenant } },
        body,
        ...(signal === undefined ? {} : { signal }),
      }),
    );
    if (data === undefined) throw queryError(response.status, error);
    return decoded(decodeInstant, data);
  }

  async checkDataSource(tenant: string, signal?: AbortSignal): Promise<DataSourceStatus> {
    const { data, error, response } = await send(() =>
      this.client.GET('/api/dash/v1/datasource/check', {
        params: { query: { tenant } },
        ...(signal === undefined ? {} : { signal }),
      }),
    );
    if (data === undefined) throw queryError(response.status, error);
    const state = DATA_SOURCE_STATES[data.state];
    return data.checked_at === undefined ? { state } : { state, checkedAtMs: data.checked_at };
  }
}
