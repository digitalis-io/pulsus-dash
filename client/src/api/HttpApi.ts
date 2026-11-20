/**
 * The BFF client (ADR-0014 §1, ADR-0015): `openapi-fetch` over the types generated from
 * `api/openapi.yaml`. The session comes from `GET /api/dash/v1/bootstrap`. There is no boards API
 * until #61, so the board lists are empty and a board is not found.
 */
import createClient, { type Client } from 'openapi-fetch';
import type { Api } from './Api';
import type { components, paths } from './gen/schema';
import {
  ApiError,
  type Board,
  type BoardList,
  type BoardSpec,
  type PanelData,
  type PanelSpec,
  type SaveResult,
  type Session,
  type TimeWindow,
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

  listBoards(): Promise<BoardList> {
    return Promise.resolve({ items: [], truncated: false });
  }

  getBoard(_tenant: string, uid: string): Promise<Board> {
    return Promise.reject(new ApiError('notFound', `board ${uid} not found`));
  }

  createBoard(_tenant: string, _spec: BoardSpec): Promise<Board> {
    return Promise.reject(new ApiError('notImplemented', 'createBoard'));
  }

  saveBoard(_tenant: string, _uid: string, _etag: string, _spec: BoardSpec): Promise<SaveResult> {
    return Promise.reject(new ApiError('notImplemented', 'saveBoard'));
  }

  deleteBoard(_tenant: string, _uid: string, _etag: string): Promise<void> {
    return Promise.reject(new ApiError('notImplemented', 'deleteBoard'));
  }

  panelData(_tenant: string, _panel: PanelSpec, _window: TimeWindow): Promise<PanelData> {
    return Promise.reject(new ApiError('notImplemented', 'panelData'));
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
