/**
 * The client's API types (§3.2 of plan #57, §3.1 of plan #61 Part B). `StubApi` serves `npm run dev`
 * and the tests; `HttpApi` is the BFF client over the types generated from the OpenAPI document
 * (ADR-0015).
 */
import type { components } from './gen/schema';
import type { FrameData, TimeWindow, VisSpec } from '../engine/api';

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

export type BoardSpec = components['schemas']['BoardSpec'];
export type PanelSpec = components['schemas']['Panel'];
export type SectionSpec = components['schemas']['Section'];
export type GridPos = components['schemas']['Grid'];
export type TimeRangeSpec = components['schemas']['TimeRange'];
/** `'promql' | 'logql'`. */
export type QueryLang = PanelSpec['query']['lang'];
/** `'auto' | 'line' | 'bars' | 'heatmap' | 'stat' | 'logs'`. */
export type PanelVisKind = PanelSpec['vis']['kind'];

/** A board of the organisation (boards are not per tenant; the tenant picks the data source). */
export interface BoardSummary {
  uid: string;
  title: string;
  version: number;
  /** ISO-8601 UTC. */
  updatedAt: string;
  /** `updated_by.name`. */
  updatedBy: string;
}

export interface BoardList {
  items: BoardSummary[];
  /** True when the list stops at the 1 000 most recently updated boards. */
  truncated: boolean;
}

/** The board head: its summary, the etag to save against and the spec. */
export interface Board extends BoardSummary {
  etag: string;
  spec: BoardSpec;
}

export interface SaveResult {
  board: Board;
  /** False when the saved spec equals the head (no new version). */
  changed: boolean;
}

/** One problem of a spec: a JSON pointer and a message key (`field.<key>` in the catalogue). */
export interface FieldError {
  pointer: string;
  messageKey: string;
}

/** What a panel shows: a chart frame, or why it shows none yet. */
export type PanelData =
  | { kind: 'frame'; spec: VisSpec; data: FrameData }
  /** The BFF has no query route for the language yet (#64, #67). */
  | { kind: 'noRoute'; lang: QueryLang }
  /** Visualisation `logs`: the log stream arrives with LogQL panels. */
  | { kind: 'noVis' };

export type { TimeWindow };

export type ApiErrorKind =
  'notFound' | 'unauthorised' | 'network' | 'notImplemented' | 'conflict' | 'invalid' | 'unknown';

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  /** The spec problems; empty unless `kind` is `invalid`. */
  readonly fields: readonly FieldError[];

  constructor(kind: ApiErrorKind, message: string, fields: readonly FieldError[] = []) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.fields = fields;
  }
}

/** A save or delete against a stale etag (409); `current` is the board head now. */
export class BoardConflictError extends ApiError {
  readonly current: Board;

  constructor(current: Board, message = 'board changed since it was read') {
    super('conflict', message);
    this.name = 'BoardConflictError';
    this.current = current;
  }
}

export function isApiError(e: unknown, kind?: ApiErrorKind): e is ApiError {
  return e instanceof ApiError && (kind === undefined || e.kind === kind);
}
