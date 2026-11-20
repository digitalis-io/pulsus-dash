/**
 * The client's API seam (§3.2 of plan #57). `StubApi` serves `npm run dev` and the tests; `HttpApi`
 * becomes the BFF client generated from the OpenAPI document (ADR-0015, #59).
 */
export type Role = 'admin' | 'editor' | 'viewer';

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
}

/** The data-source check state of a tenant binding; only "not checked" until #62. */
export interface DataSourceStatus {
  state: 'notChecked';
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

export type ApiErrorKind = 'notFound' | 'unauthorised' | 'network' | 'notImplemented' | 'unknown';

export class ApiError extends Error {
  readonly kind: ApiErrorKind;

  constructor(kind: ApiErrorKind, message: string) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
  }
}

export function isApiError(e: unknown, kind?: ApiErrorKind): e is ApiError {
  return e instanceof ApiError && (kind === undefined || e.kind === kind);
}
