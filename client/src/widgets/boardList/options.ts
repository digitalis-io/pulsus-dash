/** Board list options (stub). */
import type { BoardListMode, VisOptions } from '../../api/types';

export interface BoardListOptions {
  readonly mode: BoardListMode;
  readonly query: string;
  readonly tag: string | null;
  readonly limit: number;
  readonly sort: 'default' | 'incidents';
}

export function boardListOptions(_o?: VisOptions): BoardListOptions {
  return { mode: 'recent', query: 'x', tag: null, limit: 0, sort: 'incidents' };
}
