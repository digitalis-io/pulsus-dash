/**
 * The BFF client (ADR-0014 §1, ADR-0015): `openapi-fetch` over the types generated from
 * `api/openapi.yaml`. The session comes from `GET /api/dash/v1/bootstrap`; boards from the boards
 * API (`docs/server/boards-api.md`, plan #61 Part B §3.3); Starred and Recent from the `/me/…`
 * routes (Part C §3.2). Board panels and Explore use the same query routes (plan #64). PromQL and
 * LogQL query responses are decoded at the one seam, `data/decode.ts`; failures map to `ApiError`
 * kinds (plan #62 §4.5, plan #65 Part B §4.4).
 */
import createClient, { type Client } from 'openapi-fetch';
import { RECENT_LIMIT } from '../boards/queries';
import { isWidgetKind } from '../widgets/spec';
import type { Api } from './Api';
import type { components, paths } from './gen/schema';
import {
  DecodeError,
  decodeInstant,
  decodeLogqlPlanned,
  decodeLogs,
  decodeMetadata,
  decodeRange,
  decodeSeriesSet,
  decodeValues,
  decodeVolume,
  type InstantResult,
  type LogsResult,
  type PromMetadata,
  type PromSeriesSet,
  type PromValues,
  type RangeResult,
  type VolumeResult,
} from '../data/decode';
import {
  ApiError,
  BoardConflictError,
  type Board,
  type AnnotationList,
  type BoardPage,
  type BoardRef,
  type RefPage,
  type BoardSpec,
  type DataSourceStatus,
  type InstantRequest,
  type LogMatchRequest,
  type LogsRequest,
  type PanelSpec,
  type PromMatchRequest,
  type RangeRequest,
  type SaveResult,
  type Session,
  type VolumeRequest,
} from './types';
import { errorFromRow, rangeFromDecoded } from '../data/dsfRange';
import { messageOf, queryError } from './queryError';
import {
  DSF_ACCEPT,
  DSF_TYPE,
  DecodeFailed,
  EngineDeclined,
  decodeStats,
  rangeDecoder,
  type DecodedRange,
  type RangeDecoder,
} from './rangeDecoder';

type Bootstrap = components['schemas']['Bootstrap'];
type ErrorEnvelope = components['schemas']['ErrorEnvelope'];
/** The range route (`rum:wire_invalid`'s route). */
const RANGE_ROUTE = '/api/dash/v1/query/promql/range';

/**
 * A malformed or invalid DSF body (T04-010; plan #68 D2 §4.1): `internal`, never retried, and the
 * RUM event `rum:wire_invalid` as a User Timing mark (no RUM transport exists yet).
 */
function wireInvalid(message: string): ApiError {
  try {
    performance.mark('rum:wire_invalid', { detail: { route: RANGE_ROUTE, message } });
  } catch {
    // The User Timing API is optional.
  }
  return new ApiError('internal', message);
}
type WireBoard = components['schemas']['Board'];
type WireSummary = components['schemas']['BoardSummary'];
type WireConflict = components['schemas']['BoardConflict'];
type WireRef = components['schemas']['BoardRef'];

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

/** The summary members a board and a list row share. */
function toSummary(
  b: Pick<WireSummary, 'uid' | 'title' | 'version' | 'updated_at' | 'updated_by'>,
) {
  return {
    uid: b.uid,
    title: b.title,
    version: b.version,
    updatedAt: b.updated_at,
    updatedBy: b.updated_by.name,
  };
}

function toRef(r: WireRef): BoardRef {
  return { uid: r.uid, title: r.title };
}

/**
 * A `GET /boards` answer (plan #216 Part 1 §4.2). An old server, one without board search, sends no
 * `applied`, `tagsStale` or item `tags`: they read as null, 0 and null. Absence is checked with
 * `Object.hasOwn`, since the generated types call every member required.
 */
function toBoardPage(list: components['schemas']['BoardList']): BoardPage {
  return {
    items: list.items.map((x) => ({
      ...toSummary(x),
      tags: Object.hasOwn(x, 'tags') ? x.tags : null,
    })),
    truncated: list.truncated,
    applied: Object.hasOwn(list, 'applied') ? list.applied : null,
    tagsStale: Object.hasOwn(list, 'tagsStale') ? list.tagsStale : 0,
  };
}

/** A Starred or Recent answer: an old server's (no `applied`) is `truncated` false, `applied` null. */
function toRefPage(list: components['schemas']['BoardRefList']): RefPage {
  return {
    items: list.items.map(toRef),
    truncated: Object.hasOwn(list, 'truncated') ? list.truncated : false,
    applied: Object.hasOwn(list, 'applied') ? {} : null,
  };
}

type WireSpec = WireBoard['spec'];
type WirePanel = WireSpec['panels'][number];

/**
 * A panel the server sent, as the client's union (plan #198 Part 1 §3.3): a widget kind without a
 * query, else a data panel, which must have one. The server sends only valid specs; a data panel
 * without a query is a bad response.
 */
function toPanel(p: WirePanel): PanelSpec {
  const { query, vis, ...rest } = p;
  const kind = vis.kind;
  if (isWidgetKind(kind)) return { ...rest, vis: { ...vis, kind } };
  if (query === undefined) {
    throw new ApiError('badResponse', `panel ${p.id} has no query`);
  }
  return { ...rest, query, vis: { ...vis, kind } };
}

function toSpec(s: WireSpec): BoardSpec {
  return {
    ...s,
    panels: s.panels.map(toPanel),
    sections: s.sections.map((x) => ({ ...x, panels: x.panels.map(toPanel) })),
  };
}

function toBoard(b: WireBoard): Board {
  return { ...toSummary(b), etag: b.etag, spec: toSpec(b.spec) };
}

// The generated request types make timeout_ms required because it has a default (the generator's
// default-non-nullable rule); the BFF applies the default, so the client omits it when unset.
type RangeBody = components['schemas']['PromRangeRequest'];
type InstantBody = components['schemas']['PromInstantRequest'];
type LogsBody = components['schemas']['LogqlRangeRequest'];
type VolumeBody = components['schemas']['LogqlVolumeRequest'];

/** The range request body; the optional members only when given. */
function rangeBody(req: RangeRequest): RangeBody {
  return {
    query: req.query,
    from: req.fromMs,
    to: req.toMs,
    width_px: req.widthPx,
    ...(req.timeoutMs === undefined ? {} : { timeout_ms: req.timeoutMs }),
    ...(req.vars === undefined ? {} : { vars: { ...req.vars } }),
    ...(req.rate === undefined ? {} : { rate: req.rate }),
  } as RangeBody;
}

/** Runs a query request: an abort is re-thrown unchanged, any other rejection is `network`. */
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

/** The query of a `/prom/*` read: `match` repeated in order and omitted when empty. */
/** The query of a log label lookup: `query` only when non-empty, `limit` only when given. */
function logQuery(
  tenant: string,
  req: LogMatchRequest,
): { tenant: string; from: number; to: number; query?: string; limit?: number } {
  return {
    tenant,
    from: req.fromMs,
    to: req.toMs,
    ...(req.query === undefined || req.query === '' ? {} : { query: req.query }),
    ...(req.limit === undefined ? {} : { limit: req.limit }),
  };
}

function matchQuery(
  tenant: string,
  req: PromMatchRequest,
): { tenant: string; from: number; to: number; match?: string[]; limit?: number } {
  return {
    tenant,
    from: req.fromMs,
    to: req.toMs,
    ...(req.match === undefined || req.match.length === 0 ? {} : { match: [...req.match] }),
    ...(req.limit === undefined ? {} : { limit: req.limit }),
  };
}

const DATA_SOURCE_STATES = {
  not_checked: 'notChecked',
  ok: 'ok',
  unreachable: 'unreachable',
  unauthorised: 'unauthorised',
  error: 'error',
} as const;

/** The field errors of an error envelope. */
function fieldsOf(error: unknown) {
  const fields = (error as Partial<ErrorEnvelope> | undefined)?.error?.fields ?? [];
  return fields.map((f) => ({ pointer: f.pointer, messageKey: f.message_key }));
}

interface Result<T> {
  data?: T;
  error?: unknown;
  response: Response;
}

/**
 * Runs one boards request: a thrown fetch error is `network` (an abort is re-thrown), 404
 * `notFound`, 400 `invalid` with the envelope's fields, 409 `BoardConflictError`, 503
 * `unavailable` (the configuration store; plan #216 Part 2a); any other status without a body of
 * the success type is `unknown` with the envelope's message.
 */
async function call<T>(request: () => Promise<Result<T>>, ok: number): Promise<T | undefined> {
  let r: Result<T>;
  try {
    r = await request();
  } catch (e) {
    if (isAbort(e)) throw e;
    throw new ApiError('network', 'the BFF could not be reached');
  }
  const status = r.response.status;
  if (status === ok) return r.data;
  if (status === 404) throw new ApiError('notFound', messageOf(r.error, status));
  if (status === 400) {
    throw new ApiError('invalid', messageOf(r.error, status), { fields: fieldsOf(r.error) });
  }
  if (status === 409) {
    const current = (r.error as Partial<WireConflict> | undefined)?.current;
    if (current !== undefined)
      throw new BoardConflictError(toBoard(current), messageOf(r.error, status));
  }
  if (status === 503) throw new ApiError('unavailable', messageOf(r.error, status));
  throw new ApiError('unknown', messageOf(r.error, status));
}

function required<T>(v: T | undefined): T {
  if (v === undefined) throw new ApiError('unknown', 'the BFF sent no body');
  return v;
}

const ifMatch = (etag: string) => ({ 'If-Match': `"${etag}"` });

export class HttpApi implements Api {
  /** The session's tenant slugs, once `getSession` has answered. */
  private tenants: ReadonlySet<string> | null = null;

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
    const session = toSession(data);
    this.tenants = new Set(session.tenants.map((t) => t.slug));
    return session;
  }

  /** Boards belong to the organisation; an unknown tenant is still `notFound`. */
  private checkTenant(tenant: string): void {
    if (this.tenants !== null && !this.tenants.has(tenant)) {
      throw new ApiError('notFound', `tenant ${tenant} not found`);
    }
  }

  /** `q` is sent only when non-empty, `tag` only when given (plan #216 Part 1 §4.2). */
  async listBoards(
    tenant: string,
    signal?: AbortSignal,
    f?: { readonly q?: string; readonly tag?: string },
  ): Promise<BoardPage> {
    this.checkTenant(tenant);
    const query = {
      ...(f?.q !== undefined && f.q !== '' ? { q: f.q } : {}),
      ...(f?.tag !== undefined ? { tag: f.tag } : {}),
    };
    const list = required(
      await call(
        () =>
          this.client.GET('/api/dash/v1/boards', {
            params: { query },
            ...(signal === undefined ? {} : { signal }),
          }),
        200,
      ),
    );
    return toBoardPage(list);
  }

  async getBoard(tenant: string, uid: string, signal?: AbortSignal): Promise<Board> {
    this.checkTenant(tenant);
    const b = await call(
      () =>
        this.client.GET('/api/dash/v1/boards/{uid}', {
          params: { path: { uid } },
          ...(signal === undefined ? {} : { signal }),
        }),
      200,
    );
    return toBoard(required(b));
  }

  async createBoard(tenant: string, spec: BoardSpec): Promise<Board> {
    this.checkTenant(tenant);
    const b = await call(() => this.client.POST('/api/dash/v1/boards', { body: { spec } }), 201);
    return toBoard(required(b));
  }

  async saveBoard(tenant: string, uid: string, etag: string, spec: BoardSpec): Promise<SaveResult> {
    this.checkTenant(tenant);
    const r = required(
      await call(
        () =>
          this.client.PUT('/api/dash/v1/boards/{uid}', {
            params: { path: { uid }, header: ifMatch(etag) },
            body: { spec },
          }),
        200,
      ),
    );
    return { board: toBoard(r.board), changed: r.changed };
  }

  async deleteBoard(tenant: string, uid: string, etag: string): Promise<void> {
    this.checkTenant(tenant);
    await call(
      () =>
        this.client.DELETE('/api/dash/v1/boards/{uid}', {
          params: { path: { uid }, header: ifMatch(etag) },
        }),
      204,
    );
  }

  async listStarred(tenant: string, signal?: AbortSignal): Promise<RefPage> {
    this.checkTenant(tenant);
    const list = await call(
      () =>
        this.client.GET('/api/dash/v1/me/starred-boards', signal === undefined ? {} : { signal }),
      200,
    );
    return toRefPage(required(list));
  }

  async setStarred(tenant: string, uid: string, starred: boolean): Promise<void> {
    this.checkTenant(tenant);
    const init = { params: { path: { uid } } };
    await call(
      () =>
        starred
          ? this.client.PUT('/api/dash/v1/me/starred-boards/{uid}', init)
          : this.client.DELETE('/api/dash/v1/me/starred-boards/{uid}', init),
      204,
    );
  }

  async listRecent(tenant: string, signal?: AbortSignal, limit?: number): Promise<RefPage> {
    this.checkTenant(tenant);
    const list = await call(
      () =>
        this.client.GET('/api/dash/v1/me/recent-boards', {
          params: { query: { limit: limit ?? RECENT_LIMIT } },
          ...(signal === undefined ? {} : { signal }),
        }),
      200,
    );
    return toRefPage(required(list));
  }

  async recordView(tenant: string, uid: string, at: number, signal?: AbortSignal): Promise<void> {
    this.checkTenant(tenant);
    await call(
      () =>
        this.client.PUT('/api/dash/v1/me/recent-boards/{uid}', {
          params: { path: { uid }, query: { at } },
          ...(signal === undefined ? {} : { signal }),
        }),
      204,
    );
  }

  /** `GET /annotations?from&to` (no `limit`: the server's 500); 503 → `unavailable`. */
  async listAnnotations(
    tenant: string,
    w: { fromMs: number; toMs: number },
    signal?: AbortSignal,
  ): Promise<AnnotationList> {
    this.checkTenant(tenant);
    let r;
    try {
      r = await this.client.GET('/api/dash/v1/annotations', {
        params: { query: { from: w.fromMs, to: w.toMs } },
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (e) {
      if (isAbort(e)) throw e;
      throw new ApiError('network', 'the BFF could not be reached');
    }
    const status = r.response.status;
    if (status === 200) return required(r.data);
    if (status === 503) throw new ApiError('unavailable', messageOf(r.error, status));
    if (status === 400) {
      throw new ApiError('invalid', messageOf(r.error, status), { fields: fieldsOf(r.error) });
    }
    throw new ApiError('unknown', messageOf(r.error, status));
  }

  /** Never offered: `canSignOut` is false under the fixed local principal (D12). */
  signOut(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * `POST …/query/promql/range` (plan #68 D2 §4.1): with a range decoder (an MT engine booted) it
   * asks for DSF and hands the body to the engine unparsed; a declined body (`limit`, `ids`,
   * `busy`, `gone`) is retried once as JSON; an `error/1` row is its class's `ApiError`; a malformed
   * body is `internal`. Without a decoder, or on a JSON answer, the JSON decode.
   */
  async queryRange(tenant: string, req: RangeRequest, signal?: AbortSignal): Promise<RangeResult> {
    const decoder = rangeDecoder();
    if (decoder === null) return this.rangeJson(tenant, req, signal);
    const { data, error, response } = await send(() =>
      this.client.POST(RANGE_ROUTE, {
        params: { query: { tenant } },
        body: rangeBody(req),
        headers: { Accept: DSF_ACCEPT },
        parseAs: 'stream',
        ...(signal === undefined ? {} : { signal }),
      }),
    );
    if (data === undefined || data === null) throw queryError(response.status, error);
    const body = data as unknown as ReadableStream<Uint8Array>;
    const type = response.headers.get('Content-Type') ?? '';
    if (!type.startsWith(DSF_TYPE)) {
      // A JSON answer (a BFF that does not serve DSF): the JSON decode, unchanged.
      let json: unknown;
      try {
        json = await new Response(body).json();
      } catch (e) {
        if (isAbort(e)) throw e;
        throw new ApiError('badResponse', 'the range body is not JSON');
      }
      return decoded(decodeRange, json);
    }
    let m: DecodedRange;
    try {
      m = await decoder.decode(body, signal);
    } catch (e) {
      if (e instanceof EngineDeclined) {
        decodeStats.retried++;
        return this.rangeJson(tenant, req, signal);
      }
      if (e instanceof DecodeFailed) {
        if (e.kind === 'error' && e.row !== null) throw errorFromRow(e.row, e.coverage, e.planned);
        throw wireInvalid(e.message);
      }
      if (isAbort(e)) throw e;
      throw new ApiError('network', 'the BFF could not be reached');
    }
    return this.assemble(decoder, m);
  }

  /** The `RangeResult` of a decoded message, its series registered against the chunk. */
  private assemble(decoder: RangeDecoder, m: DecodedRange): RangeResult {
    let result: RangeResult;
    try {
      result = rangeFromDecoded(m, Date.now());
    } catch (e) {
      // The chunk is in the worker's table already, and no array will hold it.
      decoder.release(m);
      if (e instanceof DecodeError) {
        throw wireInvalid(`${e.message} at ${e.path === '' ? '/' : e.path}`);
      }
      throw e;
    }
    decoder.register(result.series, m);
    return result;
  }

  private async rangeJson(
    tenant: string,
    req: RangeRequest,
    signal?: AbortSignal,
  ): Promise<RangeResult> {
    const { data, error, response } = await send(() =>
      this.client.POST(RANGE_ROUTE, {
        params: { query: { tenant } },
        body: rangeBody(req),
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
      ...(req.vars === undefined ? {} : { vars: { ...req.vars } }),
      ...(req.stepMs === undefined ? {} : { step_ms: req.stepMs }),
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

  /** POST …/query/logql/range: the optional members only when given (plan #65 Part B §4.4). */
  async queryLogs(tenant: string, req: LogsRequest, signal?: AbortSignal): Promise<LogsResult> {
    const body = {
      query: req.query,
      from: req.fromMs,
      to: req.toMs,
      width_px: req.widthPx,
      ...(req.limit === undefined ? {} : { limit: req.limit }),
      ...(req.direction === undefined ? {} : { direction: req.direction }),
      ...(req.cursor === undefined ? {} : { cursor: req.cursor }),
      ...(req.timeoutMs === undefined ? {} : { timeout_ms: req.timeoutMs }),
      ...(req.vars === undefined ? {} : { vars: { ...req.vars } }),
    } as LogsBody;
    const { data, error, response } = await send(() =>
      this.client.POST('/api/dash/v1/query/logql/range', {
        params: { query: { tenant } },
        body,
        ...(signal === undefined ? {} : { signal }),
      }),
    );
    if (data === undefined) throw queryError(response.status, error, decodeLogqlPlanned);
    return decoded(decodeLogs, data);
  }

  /** POST …/query/logql/volume. */
  async queryVolume(
    tenant: string,
    req: VolumeRequest,
    signal?: AbortSignal,
  ): Promise<VolumeResult> {
    const body = {
      query: req.query,
      from: req.fromMs,
      to: req.toMs,
      width_px: req.widthPx,
      ...(req.timeoutMs === undefined ? {} : { timeout_ms: req.timeoutMs }),
      ...(req.vars === undefined ? {} : { vars: { ...req.vars } }),
    } as VolumeBody;
    const { data, error, response } = await send(() =>
      this.client.POST('/api/dash/v1/query/logql/volume', {
        params: { query: { tenant } },
        body,
        ...(signal === undefined ? {} : { signal }),
      }),
    );
    if (data === undefined) throw queryError(response.status, error, decodeLogqlPlanned);
    return decoded(decodeVolume, data);
  }

  async promLabels(
    tenant: string,
    req: PromMatchRequest,
    signal?: AbortSignal,
  ): Promise<PromValues> {
    const { data, error, response } = await send(() =>
      this.client.GET('/api/dash/v1/prom/labels', {
        params: { query: matchQuery(tenant, req) },
        ...(signal === undefined ? {} : { signal }),
      }),
    );
    if (data === undefined) throw queryError(response.status, error);
    return decoded(decodeValues, data);
  }

  async promLabelValues(
    tenant: string,
    name: string,
    req: PromMatchRequest,
    signal?: AbortSignal,
  ): Promise<PromValues> {
    const { data, error, response } = await send(() =>
      this.client.GET('/api/dash/v1/prom/label/{name}/values', {
        params: { path: { name }, query: matchQuery(tenant, req) },
        ...(signal === undefined ? {} : { signal }),
      }),
    );
    if (data === undefined) throw queryError(response.status, error);
    return decoded(decodeValues, data);
  }

  async promSeries(
    tenant: string,
    req: PromMatchRequest & { readonly match: readonly [string, ...string[]] },
    signal?: AbortSignal,
  ): Promise<PromSeriesSet> {
    const { data, error, response } = await send(() =>
      this.client.GET('/api/dash/v1/prom/series', {
        params: { query: { ...matchQuery(tenant, req), match: [...req.match] } },
        ...(signal === undefined ? {} : { signal }),
      }),
    );
    if (data === undefined) throw queryError(response.status, error);
    return decoded(decodeSeriesSet, data);
  }

  /** GET …/logs/labels (plan #66 Part A §3.2). */
  async logLabels(tenant: string, req: LogMatchRequest, signal?: AbortSignal): Promise<PromValues> {
    const { data, error, response } = await send(() =>
      this.client.GET('/api/dash/v1/logs/labels', {
        params: { query: logQuery(tenant, req) },
        ...(signal === undefined ? {} : { signal }),
      }),
    );
    if (data === undefined) throw queryError(response.status, error);
    return decoded(decodeValues, data);
  }

  /** GET …/logs/label/{name}/values; openapi-fetch percent-encodes `name`. */
  async logLabelValues(
    tenant: string,
    name: string,
    req: LogMatchRequest,
    signal?: AbortSignal,
  ): Promise<PromValues> {
    const { data, error, response } = await send(() =>
      this.client.GET('/api/dash/v1/logs/label/{name}/values', {
        params: { path: { name }, query: logQuery(tenant, req) },
        ...(signal === undefined ? {} : { signal }),
      }),
    );
    if (data === undefined) throw queryError(response.status, error);
    return decoded(decodeValues, data);
  }

  async promMetadata(
    tenant: string,
    req: { readonly metric?: string; readonly limit?: number },
    signal?: AbortSignal,
  ): Promise<PromMetadata> {
    const { data, error, response } = await send(() =>
      this.client.GET('/api/dash/v1/prom/metadata', {
        params: {
          query: {
            tenant,
            ...(req.metric === undefined ? {} : { metric: req.metric }),
            ...(req.limit === undefined ? {} : { limit: req.limit }),
          },
        },
        ...(signal === undefined ? {} : { signal }),
      }),
    );
    if (data === undefined) throw queryError(response.status, error);
    return decoded(decodeMetadata, data);
  }
}
