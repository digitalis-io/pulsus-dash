import type {
  Board,
  BoardList,
  BoardRef,
  BoardSpec,
  PanelData,
  PanelSpec,
  SaveResult,
  Session,
  TimeWindow,
} from './types';

/**
 * The API seam. Boards belong to the organisation: `tenant` is checked against the session's
 * tenants (unknown → `ApiError('notFound')`) and otherwise only selects the data source of
 * `panelData`.
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
  /** What one panel shows over `window`. */
  panelData(
    tenant: string,
    panel: PanelSpec,
    window: TimeWindow,
    signal?: AbortSignal,
  ): Promise<PanelData>;
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
}
