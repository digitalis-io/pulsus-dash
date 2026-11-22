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
  Board,
  BoardList,
  BoardRef,
  BoardSpec,
  DataSourceStatus,
  InstantRequest,
  LogsRequest,
  PromMatchRequest,
  RangeRequest,
  SaveResult,
  Session,
  VolumeRequest,
} from './types';

/**
 * The API seam. Boards belong to the organisation: `tenant` is checked against the session's
 * tenants (unknown → `ApiError('notFound')`) and otherwise only selects the data source of the
 * queries.
 */
export interface Api {
  getSession(signal?: AbortSignal): Promise<Session>;
  listBoards(tenant: string, signal?: AbortSignal): Promise<BoardList>;
  /** Unknown board → `ApiError('notFound')`. */
  getBoard(tenant: string, uid: string, signal?: AbortSignal): Promise<Board>;
  /** An invalid spec → `ApiError('invalid')` with `fields`. */
  createBoard(tenant: string, spec: BoardSpec): Promise<Board>;
  /** `notFound`, `invalid`, or `BoardConflictError` when `etag` is not the head's. */
  saveBoard(tenant: string, uid: string, etag: string, spec: BoardSpec): Promise<SaveResult>;
  /** `notFound`, or `BoardConflictError` when `etag` is not the head's. */
  deleteBoard(tenant: string, uid: string, etag: string): Promise<void>;
  /** Starred boards of the principal, in the server's order (title, then uid). */
  listStarred(tenant: string, signal?: AbortSignal): Promise<BoardRef[]>;
  /** Star: unknown or deleted board → `notFound`. Unstar: idempotent, never `notFound`. */
  setStarred(tenant: string, uid: string, starred: boolean): Promise<void>;
  /** The principal's `RECENT_LIMIT` most recently opened boards, newest first. */
  listRecent(tenant: string, signal?: AbortSignal): Promise<BoardRef[]>;
  /**
   * Records that the principal opened `uid` at `at` (integer ms since the Unix epoch; the greater
   * of the stored and the new time wins). Unknown or deleted → `notFound`. Abort is rethrown.
   */
  recordView(tenant: string, uid: string, at: number, signal?: AbortSignal): Promise<void>;
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
  /** Metric metadata (`GET /prom/metadata`). */
  promMetadata(
    tenant: string,
    req: { readonly metric?: string; readonly limit?: number },
    signal?: AbortSignal,
  ): Promise<PromMetadata>;
}
