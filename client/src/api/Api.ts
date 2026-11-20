import type { InstantResult, RangeResult } from '../data/decode';
import type {
  BoardSummary,
  DataSourceStatus,
  InstantRequest,
  RangeRequest,
  Session,
} from './types';

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
  /** A PromQL range query on the BFF's grid (plan #62 §4.5). */
  queryRange(tenant: string, req: RangeRequest, signal?: AbortSignal): Promise<RangeResult>;
  /** A PromQL instant query. */
  queryInstant(tenant: string, req: InstantRequest, signal?: AbortSignal): Promise<InstantResult>;
  /** The data-source check of the tenant's binding (T06-025). */
  checkDataSource(tenant: string, signal?: AbortSignal): Promise<DataSourceStatus>;
}
