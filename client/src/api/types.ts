/**
 * The client's API seam (§3.2 of plan #57). `StubApi` serves `npm run dev` and the tests; `HttpApi`
 * is the BFF client generated from the OpenAPI document (ADR-0015, #59, #62).
 */
export type Role = 'admin' | 'editor' | 'viewer';

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
}

/** The data-source check state of a tenant binding (T06-025). */
export type DataSourceState = 'notChecked' | 'ok' | 'unreachable' | 'unauthorised' | 'error';

export interface DataSourceStatus {
  state: DataSourceState;
  /** ms; absent while not checked. */
  checkedAtMs?: number;
}

export interface RangeRequest {
  query: string;
  fromMs: number;
  toMs: number;
  widthPx: number;
  timeoutMs?: number;
}

export interface InstantRequest {
  query: string;
  atMs: number;
  timeoutMs?: number;
}

export interface Tenant {
  slug: string;
  name: string;
  dataSource?: DataSourceStatus;
}

export interface ServerInfo {
  version: string;
  commit: string;
}

export interface Org {
  name: string;
}

export interface Session {
  user: User;
  org: Org;
  /** The user's tenant bindings. */
  tenants: Tenant[];
  defaultTenant: string;
  /** The BFF build; null in stub mode. */
  server: ServerInfo | null;
  /** False under the fixed local principal (D12). */
  canSignOut: boolean;
}

export interface BoardSummary {
  uid: string;
  title: string;
  /** ISO-8601 UTC. */
  updatedAt: string;
}

export type ApiErrorKind =
  | 'notFound'
  | 'unauthorised'
  | 'network'
  | 'notImplemented'
  | 'unknown'
  | 'queryInvalid'
  | 'tooBroad'
  | 'timeout'
  | 'unavailable'
  | 'busy'
  | 'badResponse';

/** What the BFF said about a failed query (§4.5 of plan #62). */
export interface ApiErrorDetail {
  queryId?: string;
  /** Byte offset into the query text (T09-009). */
  position?: number;
  hint?: Readonly<Record<string, unknown>>;
}

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly detail: ApiErrorDetail;

  constructor(kind: ApiErrorKind, message: string, detail: ApiErrorDetail = {}) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.detail = detail;
  }
}

export function isApiError(e: unknown, kind?: ApiErrorKind): e is ApiError {
  return e instanceof ApiError && (kind === undefined || e.kind === kind);
}
