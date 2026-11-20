/**
 * The BFF client (ADR-0014 §1, ADR-0015): `openapi-fetch` over the types generated from
 * `api/openapi.yaml`. The session comes from `GET /api/dash/v1/bootstrap`; boards from the boards
 * API (`docs/server/boards-api.md`, plan #61 Part B §3.3). Panels have no query route yet (#64,
 * #67): `panelData` answers without a request.
 */
import createClient, { type Client } from 'openapi-fetch';
import type { Api } from './Api';
import type { components, paths } from './gen/schema';
import {
  ApiError,
  BoardConflictError,
  type Board,
  type BoardList,
  type BoardSpec,
  type PanelData,
  type PanelSpec,
  type SaveResult,
  type Session,
} from './types';

type Bootstrap = components['schemas']['Bootstrap'];
type ErrorEnvelope = components['schemas']['ErrorEnvelope'];
type WireBoard = components['schemas']['Board'];
type WireSummary = components['schemas']['BoardSummary'];
type WireConflict = components['schemas']['BoardConflict'];

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

function toSummary(b: WireSummary) {
  return {
    uid: b.uid,
    title: b.title,
    version: b.version,
    updatedAt: b.updated_at,
    updatedBy: b.updated_by.name,
  };
}

function toBoard(b: WireBoard): Board {
  return { ...toSummary(b), etag: b.etag, spec: b.spec };
}

/** The envelope's message, else `HTTP <status>`. */
function messageOf(error: unknown, status: number): string {
  const msg = (error as Partial<ErrorEnvelope> | undefined)?.error?.message;
  return typeof msg === 'string' && msg !== '' ? msg : `HTTP ${String(status)}`;
}

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
 * Runs one request: a thrown fetch error is `network` (an abort is re-thrown), 404 `notFound`,
 * 400 `invalid` with the envelope's fields, 409 `BoardConflictError`; any other status without a
 * body of the success type is `unknown` with the envelope's message.
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
  if (status === 400) throw new ApiError('invalid', messageOf(r.error, status), fieldsOf(r.error));
  if (status === 409) {
    const current = (r.error as Partial<WireConflict> | undefined)?.current;
    if (current !== undefined)
      throw new BoardConflictError(toBoard(current), messageOf(r.error, status));
  }
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

  async listBoards(tenant: string, signal?: AbortSignal): Promise<BoardList> {
    this.checkTenant(tenant);
    const list = required(
      await call(
        () => this.client.GET('/api/dash/v1/boards', signal === undefined ? {} : { signal }),
        200,
      ),
    );
    return { items: list.items.map(toSummary), truncated: list.truncated };
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

  /** No query route yet (#64, #67): never a request. */
  panelData(tenant: string, panel: PanelSpec): Promise<PanelData> {
    return Promise.resolve().then((): PanelData => {
      this.checkTenant(tenant);
      if (panel.vis.kind === 'logs') return { kind: 'noVis' };
      return { kind: 'noRoute', lang: panel.query.lang };
    });
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
}
