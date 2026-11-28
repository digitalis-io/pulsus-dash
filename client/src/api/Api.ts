import type {
  InstantResult,
  LogsResult,
  PromMetadata,
  PromSeriesSet,
  PromValues,
  RangeResult,
  VolumeResult,
} from '../data/decode';
import type {
  AnnotationList,
  Board,
  BoardPage,
  BoardSpec,
  DataSourceStatus,
  InstantRequest,
  LogMatchRequest,
  LogsRequest,
  PromMatchRequest,
  RangeRequest,
  RefPage,
  SaveResult,
  Session,
  VariableValues,
  VariableValuesRequest,
  VolumeRequest,
} from './types';

/**
 * The API seam. Boards belong to the organisation: `tenant` is checked against the session's
 * tenants (unknown → `ApiError('notFound')`) and otherwise only selects the data source of the
 * queries.
 */
export interface Api {
  getSession(signal?: AbortSignal): Promise<Session>;
  /**
   * The organisation's boards, most recently updated first, at most 1 000 (T24-021): `f.q` (sent
   * only when non-empty) matches a title or equals a tag, `f.tag` equals a tag; both must hold.
   */
  listBoards(
    tenant: string,
    signal?: AbortSignal,
    f?: { readonly q?: string; readonly tag?: string },
  ): Promise<BoardPage>;
  /** Unknown board → `ApiError('notFound')`. */
  getBoard(tenant: string, uid: string, signal?: AbortSignal): Promise<Board>;
  /** An invalid spec → `ApiError('invalid')` with `fields`. */
  createBoard(tenant: string, spec: BoardSpec): Promise<Board>;
  /** `notFound`, `invalid`, or `BoardConflictError` when `etag` is not the head's. */
  saveBoard(tenant: string, uid: string, etag: string, spec: BoardSpec): Promise<SaveResult>;
  /** `notFound`, or `BoardConflictError` when `etag` is not the head's. */
  deleteBoard(tenant: string, uid: string, etag: string): Promise<void>;
  /** Starred boards of the principal, in the server's order (title, then uid). */
  listStarred(tenant: string, signal?: AbortSignal): Promise<RefPage>;
  /** Star: unknown or deleted board → `notFound`. Unstar: idempotent, never `notFound`. */
  setStarred(tenant: string, uid: string, starred: boolean): Promise<void>;
  /** The principal's `limit` (default `RECENT_LIMIT`) most recently opened boards, newest first. */
  listRecent(tenant: string, signal?: AbortSignal, limit?: number): Promise<RefPage>;
  /**
   * Records that the principal opened `uid` at `at` (integer ms since the Unix epoch; the greater
   * of the stored and the new time wins). Unknown or deleted → `notFound`. Abort is rethrown.
   */
  recordView(tenant: string, uid: string, at: number, signal?: AbortSignal): Promise<void>;
  /**
   * The organisation's annotations overlapping the window, newest first, at most 500 (plan #64 Part
   * C §3.5). `tenant` is checked as `listBoards`; the route is org-scoped (D12).
   */
  listAnnotations(
    tenant: string,
    w: { fromMs: number; toMs: number },
    signal?: AbortSignal,
  ): Promise<AnnotationList>;
  signOut(): Promise<void>;
  /** A PromQL range query on the BFF's grid (plan #62 §4.5). */
  queryRange(tenant: string, req: RangeRequest, signal?: AbortSignal): Promise<RangeResult>;
  /** A PromQL instant query. */
  queryInstant(tenant: string, req: InstantRequest, signal?: AbortSignal): Promise<InstantResult>;
  /** One page of a LogQL log query, or the frames of a LogQL metric query (plan #65 Part B §4.4). */
  queryLogs(tenant: string, req: LogsRequest, signal?: AbortSignal): Promise<LogsResult>;
  /** Log volume by level on the BFF's grid. */
  queryVolume(tenant: string, req: VolumeRequest, signal?: AbortSignal): Promise<VolumeResult>;
  /** The data-source check of the tenant's binding (T06-025). */
  checkDataSource(tenant: string, signal?: AbortSignal): Promise<DataSourceStatus>;
  /** Label names (`GET /prom/labels`). Unknown tenant → `ApiError('notFound')`; errors as `queryRange`. */
  promLabels(tenant: string, req: PromMatchRequest, signal?: AbortSignal): Promise<PromValues>;
  /** The values of label `name` (`GET /prom/label/{name}/values`). */
  promLabelValues(
    tenant: string,
    name: string,
    req: PromMatchRequest,
    signal?: AbortSignal,
  ): Promise<PromValues>;
  /** The label sets matching at least one selector (`GET /prom/series`). */
  promSeries(
    tenant: string,
    req: PromMatchRequest & { readonly match: readonly [string, ...string[]] },
    signal?: AbortSignal,
  ): Promise<PromSeriesSet>;
  /** Log label names (`GET /logs/labels`). Unknown tenant → `ApiError('notFound')`; errors as `promLabels`. */
  logLabels(tenant: string, req: LogMatchRequest, signal?: AbortSignal): Promise<PromValues>;
  /** The values of log label `name` (`GET /logs/label/{name}/values`). */
  logLabelValues(
    tenant: string,
    name: string,
    req: LogMatchRequest,
    signal?: AbortSignal,
  ): Promise<PromValues>;
  /** A board variable's values (`POST /variables/values`, plan #289 §3.5); errors as `queryRange`. */
  variableValues(
    tenant: string,
    req: VariableValuesRequest,
    signal?: AbortSignal,
  ): Promise<VariableValues>;
  /** Metric metadata (`GET /prom/metadata`). */
  promMetadata(
    tenant: string,
    req: { readonly metric?: string; readonly limit?: number },
    signal?: AbortSignal,
  ): Promise<PromMetadata>;
}
