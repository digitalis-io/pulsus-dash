/**
 * The client's API types (§3.2 of plan #57, §3.1 of plan #61 Part B). `StubApi` serves `npm run dev`
 * and the tests; `HttpApi` is the BFF client over the types generated from the OpenAPI document
 * (ADR-0015, #59, #61, #62).
 */
import type { components } from './gen/schema';
import type { FrameData, TimeWindow, VisSpec } from '../engine/api';
import type { PlannedQuery } from '../data/decode';

export type { PlannedQuery };

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

/** A range query: the raw text and the inputs the server plans it with (ADR-0021). */
export interface RangeRequest {
  query: string;
  fromMs: number;
  toMs: number;
  widthPx: number;
  timeoutMs?: number;
  vars?: Readonly<Record<string, string>>;
  /** The rate chip; omitted = on. */
  rate?: boolean;
}

/** A LogQL range request (plan #65 Part B §3.5). */
export interface LogsRequest {
  query: string;
  fromMs: number;
  toMs: number;
  widthPx: number;
  limit?: number;
  direction?: 'backward' | 'forward';
  cursor?: string;
  timeoutMs?: number;
}

/** A log volume request. */
export interface VolumeRequest {
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
  vars?: Readonly<Record<string, string>>;
  /** The step of `$__interval`, `$__rate_interval` and the rate rewrite; omitted = none. */
  stepMs?: number;
}

/** The window and selectors of a `/prom/*` metadata read (plan #63 §3.1). */
export interface PromMatchRequest {
  readonly fromMs: number;
  readonly toMs: number;
  /** Repeated `match`, in order; omitted when empty. */
  readonly match?: readonly string[];
  /** 1..10 000; omitted = the BFF's default (1 000). */
  readonly limit?: number;
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

/** A board in the principal's Starred or Recent list (`BoardRef` of the boards API). */
export interface BoardRef {
  uid: string;
  title: string;
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

/**
 * The kinds of `ApiError`. Common: `notFound`, `unauthorised`, `network`, `notImplemented`,
 * `unknown`. Boards (#61): `conflict` (a stale etag) and `invalid` (spec problems in `fields`).
 * Queries (#62 §4.5): `queryInvalid`, `tooBroad`, `timeout`, `unavailable`, `busy` and
 * `badResponse`, with what the BFF said in `detail`.
 */
export type ApiErrorKind =
  | 'notFound'
  | 'unauthorised'
  | 'network'
  | 'notImplemented'
  | 'unknown'
  | 'conflict'
  | 'invalid'
  | 'queryInvalid'
  | 'tooBroad'
  | 'timeout'
  | 'unavailable'
  | 'busy'
  | 'badResponse'
  | 'queryTooLong';

/** What the BFF said about a failed query (§4.5 of plan #62). */
export interface ApiErrorDetail {
  queryId?: string;
  /** Byte offset into the raw query text (T09-009; the server maps it, ADR-0021 §3). */
  position?: number;
  hint?: Readonly<Record<string, unknown>>;
  /** What the server planned, on every error raised after planning. */
  planned?: PlannedQuery;
}

/** The optional parts of an `ApiError`. */
export interface ApiErrorExtra {
  /** The spec problems of an `invalid` error. */
  fields?: readonly FieldError[];
  /** The BFF's answer to a failed query or check. */
  detail?: ApiErrorDetail;
}

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  /** The spec problems; empty unless `kind` is `invalid`. */
  readonly fields: readonly FieldError[];
  /** `{}` unless a query or check failed with something to say. */
  readonly detail: ApiErrorDetail;

  constructor(kind: ApiErrorKind, message: string, extra: ApiErrorExtra = {}) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.fields = extra.fields ?? [];
    this.detail = extra.detail ?? {};
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
