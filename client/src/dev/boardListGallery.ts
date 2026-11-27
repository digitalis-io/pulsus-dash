/**
 * The widget gallery's Board list pages (plan #216 Part 2a §4.6; VIZ-069, T24-027): the panels of
 * `widget-board-list`, `widget-board-list-search` and `widget-board-list-states`, each with the
 * answers its own `galleryApi` gives (the list methods only) and, for the stale panel, the answer
 * its query cache starts with. Fixtures B and S (`widgets/boardList/fixtures.ts`).
 *
 * This module imports types and the fixtures only.
 */
import type { Api } from '../api/Api';
import type { BoardPage, RefPage, WidgetPanelSpec } from '../api/types';
import { B, findS } from '../widgets/boardList/fixtures';

export const BOARD_LIST_GALLERY_PAGES = [
  'widget-board-list',
  'widget-board-list-search',
  'widget-board-list-states',
] as const;
export type BoardListGalleryPage = (typeof BOARD_LIST_GALLERY_PAGES)[number];

export function isBoardListGalleryPage(p: string): p is BoardListGalleryPage {
  return (BOARD_LIST_GALLERY_PAGES as readonly string[]).includes(p);
}

/**
 * A panel's answers: `B`, fixture B; `find`, `findS` of the request's filter; `never`, no answer;
 * `stale`, B in the cache from 12:30:00 UTC and a rejected refetch; `oldB`, B as an old server's
 * decoded answer; `none`, no items.
 */
export type GalleryAnswer = 'B' | 'find' | 'never' | 'stale' | 'oldB' | 'none';

export interface BoardListGalleryPanel {
  readonly panel: WidgetPanelSpec;
  readonly answer: GalleryAnswer;
}

/** When the stale panel's cached answer was fetched. */
export const GALLERY_STALE_FETCHED_MS = Date.parse('2026-11-26T12:30:00Z');

const list = (
  id: string,
  title: string,
  answer: GalleryAnswer,
  options?: NonNullable<WidgetPanelSpec['vis']['options']>,
): BoardListGalleryPanel => ({
  panel: {
    id,
    title,
    grid: { x: 0, y: 0, w: 6, h: 8 },
    vis: { kind: 'boardList', ...(options === undefined ? {} : { options }) },
  },
  answer,
});

export function boardListGalleryPanels(
  page: BoardListGalleryPage,
): readonly BoardListGalleryPanel[] {
  switch (page) {
    case 'widget-board-list':
      return [
        list('bl-starred', 'Starred', 'B', {}),
        list('bl-recent', 'Recent', 'B', { mode: 'recent', limit: 5 }),
      ];
    case 'widget-board-list-search':
      return [
        list('bl-find', 'Find', 'find', { mode: 'search', query: '' }),
        list('bl-team', 'Payments team', 'find', { mode: 'tag', tag: 'team:payments' }),
      ];
    case 'widget-board-list-states':
      return [
        list('bl-loading', 'Loading', 'never'),
        list('bl-stale', 'Stale', 'stale'),
        list('bl-unknown', 'Unknown', 'oldB'),
        list('bl-empty', 'Empty', 'none', { mode: 'recent' }),
      ];
  }
}

const OLD_B: RefPage = { ...B, applied: null };
const NONE: RefPage = { items: [], truncated: false, applied: {} };

/** An Api with the list methods only, answering as `answer` says. */
export function galleryApi(answer: GalleryAnswer): Api {
  const page = (f?: {
    readonly q?: string;
    readonly tag?: string;
  }): Promise<BoardPage | RefPage> => {
    switch (answer) {
      case 'B':
        return Promise.resolve(B);
      case 'find':
        return Promise.resolve(findS(f ?? {}));
      case 'never':
        return new Promise(() => undefined);
      case 'stale':
        return Promise.reject(new Error('gallery: the refresh fails'));
      case 'oldB':
        return Promise.resolve(OLD_B);
      case 'none':
        return Promise.resolve(NONE);
    }
  };
  return {
    listStarred: () => page(),
    listRecent: () => page(),
    listBoards: (
      _t: string,
      _s?: AbortSignal,
      f?: { readonly q?: string; readonly tag?: string },
    ) => page(f),
  } as unknown as Api;
}
