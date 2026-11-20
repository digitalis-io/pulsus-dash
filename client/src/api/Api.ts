import type {
  Board,
  BoardList,
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
  /** Starred board uids, per user and tenant. */
  listStarred(tenant: string, signal?: AbortSignal): Promise<string[]>;
  /** Returns the new list. */
  setStarred(tenant: string, uid: string, starred: boolean): Promise<string[]>;
  signOut(): Promise<void>;
}
