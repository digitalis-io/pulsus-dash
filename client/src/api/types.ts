/**
 * The client's API types (§3.2 of plan #57, §3.1 of plan #61 Part B). `StubApi` serves `npm run dev`
 * and the tests; `HttpApi` is the BFF client over the types generated from the OpenAPI document
 * (ADR-0015, #59, #61, #62).
 */
import type { components } from './gen/schema';
import type { TimeWindow } from '../engine/api';
import type { LogqlPlannedQuery, PlannedQuery } from '../data/decode';

export type { LogqlPlannedQuery, PlannedQuery };

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

/** A LogQL range request (plan #65 Part B §3.5, plan #116 §3.8). */
export interface LogsRequest {
  query: string;
  fromMs: number;
  toMs: number;
  widthPx: number;
  limit?: number;
  direction?: 'backward' | 'forward';
  cursor?: string;
  timeoutMs?: number;
  /** Variable values; the server substitutes them (plan #116). */
  vars?: Readonly<Record<string, string>>;
}

/** A log volume request. */
export interface VolumeRequest {
  query: string;
  fromMs: number;
  toMs: number;
  widthPx: number;
  timeoutMs?: number;
  vars?: Readonly<Record<string, string>>;
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

/** A log label lookup (`GET /logs/labels`, `/logs/label/{name}/values`; plan #66 Part A §3.2). */
export interface LogMatchRequest {
  readonly fromMs: number;
  readonly toMs: number;
  /** One stream selector, as written (never substituted); omitted when absent or ''. */
  readonly query?: string;
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

type S = components['schemas'];
/** A panel as the OpenAPI document has it: `query` optional, any kind (board spec v5). */
type RawPanel = S['Panel'];
export type GridPos = S['Grid'];
export type TimeRangeSpec = S['TimeRange'];
export type PanelQuery = S['Query'];
/** `'promql' | 'logql'`. */
export type QueryLang = PanelQuery['lang'];
export type PanelVis = RawPanel['vis'];
/** The data kinds `auto` … `pie`, and the widgets `text` and `clock` (board spec v5). */
export type PanelVisKind = PanelVis['kind'];
/** The widget kinds (T24-002): no query, chart or Inspector; `boardList` by board spec v6 (#216). */
export type WidgetKind = Extract<PanelVisKind, 'text' | 'clock' | 'boardList'>;
export type DataVisKind = Exclude<PanelVisKind, WidgetKind>;
/** A panel's `vis.options` (board spec v3, T22 §6.1; the widget keys by v5, T24 §5.1). */
export type VisOptions = NonNullable<PanelVis['options']>;
/** A text widget's code language (T24 §5.1). */
export type CodeLanguage = NonNullable<VisOptions['language']>;
export type ClockZone = S['ClockZone'];
export type ClockCountdown = S['ClockCountdown'];

/**
 * The panels of a valid spec (plan #198 Part 1 §3.3): a data panel has a query, a widget has none.
 * Every reader of `query` takes a `DataPanelSpec` (`isDataPanel` narrows), so the compiler guards
 * them all.
 */
export interface DataPanelSpec extends Omit<RawPanel, 'query' | 'vis'> {
  query: PanelQuery;
  vis: PanelVis & { kind: DataVisKind };
}
export interface WidgetPanelSpec extends Omit<RawPanel, 'query' | 'vis'> {
  query?: never;
  vis: PanelVis & { kind: WidgetKind };
}
export type PanelSpec = DataPanelSpec | WidgetPanelSpec;
export interface SectionSpec extends Omit<S['Section'], 'panels'> {
  panels: PanelSpec[];
}
export interface BoardSpec extends Omit<S['BoardSpec'], 'panels' | 'sections'> {
  panels: PanelSpec[];
  sections: SectionSpec[];
}

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

/** A board list widget's source (T24 §5.5, T24-021). */
export type BoardListMode = 'starred' | 'recent' | 'search' | 'tag';

/** A row of `GET /boards`: the summary and the board's tags (null: stale, or an old server). */
export type BoardListItem = BoardSummary & { readonly tags: readonly string[] | null };

/**
 * One answer of `GET /boards` (T24 §5.7). `applied` is what the server applied, null from an old
 * server (one without board search); `tagsStale` counts the org's boards whose tags are not known.
 */
export interface BoardPage {
  readonly items: readonly BoardListItem[];
  /** True when the list stops at the 1 000 most recently updated matching boards. */
  readonly truncated: boolean;
  readonly applied: { readonly q?: string; readonly tag?: string } | null;
  readonly tagsStale: number;
}

/** One answer of Starred or Recent; `applied` null = an old server (`truncated` then false). */
export interface RefPage {
  readonly items: readonly BoardRef[];
  readonly truncated: boolean;
  readonly applied: Readonly<Record<string, never>> | null;
}

/** The board head: its summary, the etag to save against and the spec. */
/** An event marker as the annotations API sends it (plan #64 Part C §3.5). */
export type Annotation = components['schemas']['Annotation'];
export type AnnotationList = components['schemas']['AnnotationList'];

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
  /**
   * What the server planned, on every error raised after planning: the PromQL or the LogQL plan.
   * Readers that serve both languages use only `query`, `expanded` and `bytes`.
   */
  planned?: PlannedQuery | LogqlPlannedQuery;
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
