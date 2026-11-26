/** Board list rows (stub). */
import type { BoardListMode, BoardPage, RefPage } from '../../api/types';
import { EMPTY_COVERAGE } from '../../data/frames';
import type { ListSnapshot } from '../lists/snapshot';
import type { ListTable } from '../lists/table';
import type { BoardListOptions } from './options';

export interface BoardRow {
  readonly uid: string;
  readonly title: string;
  readonly display: string;
  readonly tags: readonly string[] | null;
  readonly updatedAt: string | null;
  readonly current: boolean;
}

export function boardSnapshot(
  key: readonly unknown[],
  _r: BoardPage | RefPage,
  o: {
    readonly mode: BoardListMode;
    readonly q: string;
    readonly tag: string | null;
    readonly currentUid: string | null;
    readonly shown: number;
    readonly nowMs: number;
  },
): { readonly snapshot: ListSnapshot<BoardRow>; readonly notice: 'tagNeedsServer' | null } {
  return {
    snapshot: { key, rows: [], coverage: EMPTY_COVERAGE, fetchedAtMs: o.nowMs },
    notice: null,
  };
}

export function boardRowName(r: BoardRow): string {
  return r.title;
}

export function rankingCaption(
  _sort: BoardListOptions['sort'],
  _c: { readonly investigations: boolean },
): string | null {
  return null;
}

export function boardListTable(_s: ListSnapshot<BoardRow>): ListTable {
  return { columns: [], rows: [] };
}
