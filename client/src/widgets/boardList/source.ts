/** Stub (tests first, plan #216 Part 2a). */
/* eslint-disable @typescript-eslint/no-unused-vars -- a stub */
import type { Api } from '../../api/Api';
import type { BoardPage, RefPage } from '../../api/types';
import type { BoardListOptions } from './options';

export const RECENT_WIDGET_LIMIT = 50;

export function boardListKey(
  _tenant: string,
  _o: BoardListOptions,
  _q: string,
): readonly unknown[] {
  return [];
}

export function boardListFetch(
  _api: Api,
  _tenant: string,
  _o: BoardListOptions,
  _q: string,
  _signal: AbortSignal,
): Promise<BoardPage | RefPage> {
  return Promise.reject(new Error('stub'));
}
