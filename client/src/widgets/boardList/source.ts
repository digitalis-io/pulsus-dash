/**
 * A board list's source (plan #216 Part 2a §3.1; T24-021): one react-query key and one route per
 * mode. Starred shares the sidebar's key (`useStarred`); Recent reads 50 views under its own key
 * (the sidebar keeps `['recent', tenant]` at `RECENT_LIMIT`); search and tag share the `find` keys.
 */
import type { Api } from '../../api/Api';
import type { BoardPage, RefPage } from '../../api/types';
import type { BoardListOptions } from './options';

/** The views a Recent list reads (T24-021). */
export const RECENT_WIDGET_LIMIT = 50;

/**
 * starred `['starred', t]` · recent `['recent', t, 50]` · search `['boards', t, 'find', q, null]` ·
 * tag `['boards', t, 'find', null, tag]`. `q` is the committed (trimmed) search text.
 */
export function boardListKey(tenant: string, o: BoardListOptions, q: string): readonly unknown[] {
  switch (o.mode) {
    case 'starred':
      return ['starred', tenant];
    case 'recent':
      return ['recent', tenant, RECENT_WIDGET_LIMIT];
    case 'search':
      return ['boards', tenant, 'find', q, null];
    case 'tag':
      return ['boards', tenant, 'find', null, o.tag];
  }
}

/** The key's route: `''` searches with no `q`. */
export function boardListFetch(
  api: Api,
  tenant: string,
  o: BoardListOptions,
  q: string,
  signal: AbortSignal,
): Promise<BoardPage | RefPage> {
  switch (o.mode) {
    case 'starred':
      return api.listStarred(tenant, signal);
    case 'recent':
      return api.listRecent(tenant, signal, RECENT_WIDGET_LIMIT);
    case 'search':
      return api.listBoards(tenant, signal, q === '' ? {} : { q });
    case 'tag':
      return api.listBoards(tenant, signal, o.tag === null ? {} : { tag: o.tag });
  }
}
