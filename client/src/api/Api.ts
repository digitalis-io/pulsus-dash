import type { BoardSummary, Session } from './types';

export interface Api {
  getSession(signal?: AbortSignal): Promise<Session>;
  /** Unknown tenant → `ApiError('notFound')`. */
  listBoards(tenant: string, signal?: AbortSignal): Promise<BoardSummary[]>;
  /** Unknown tenant or board → `ApiError('notFound')`. */
  getBoard(tenant: string, uid: string, signal?: AbortSignal): Promise<BoardSummary>;
  /** Starred board uids, per user and tenant. */
  listStarred(tenant: string, signal?: AbortSignal): Promise<string[]>;
  /** Returns the new list. */
  setStarred(tenant: string, uid: string, starred: boolean): Promise<string[]>;
  signOut(): Promise<void>;
}
