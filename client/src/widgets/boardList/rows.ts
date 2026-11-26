/**
 * A board list's rows (plan #216 Part 1 §4.3; T24-022, T24-023, T24-026, T24-029): one answer as a
 * snapshot, the row names, the ranking caption and the table. Pure; the hook that reads the
 * answer is Part 2's.
 */
import type { BoardListMode, BoardPage, RefPage } from '../../api/types';
import type { Coverage } from '../../data/frames';
import { t } from '../../i18n/t';
import { listCoverage, type ListSnapshot } from '../lists/snapshot';
import type { ListTable } from '../lists/table';
import type { BoardListOptions } from './options';

export interface BoardRow {
  readonly uid: string;
  readonly title: string;
  /** The title, or `title · uid` when another loaded row has the same title. */
  readonly display: string;
  /** Null: not known (a stale row, or an old server). Starred and Recent rows have none. */
  readonly tags: readonly string[] | null;
  /** ISO 8601 UTC; null for Starred and Recent rows. */
  readonly updatedAt: string | null;
  /** The board that holds the widget. */
  readonly current: boolean;
}

/** ASCII-only lower case (T24-021: case folding is ASCII-only). */
function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

function isBoardPage(r: BoardPage | RefPage): r is BoardPage {
  return 'tagsStale' in r;
}

interface Loaded {
  readonly uid: string;
  readonly title: string;
  readonly tags: readonly string[] | null;
  readonly updatedAt: string | null;
}

/**
 * The snapshot of one answer under `key`, in the server's order. An old server (`applied` null):
 * search filters the titles here (`q` '' keeps all) with the tags unknown, tag mode has no rows and
 * the notice `tagNeedsServer`, the coverage is `unknown` and the truncation is not trusted. A new
 * server's `tagsStale` > 0 makes the coverage `unknown` (tagsStale).
 */
export function boardSnapshot(
  key: readonly unknown[],
  r: BoardPage | RefPage,
  o: {
    readonly mode: BoardListMode;
    readonly q: string;
    readonly tag: string | null;
    readonly currentUid: string | null;
    readonly shown: number;
    readonly nowMs: number;
  },
): { readonly snapshot: ListSnapshot<BoardRow>; readonly notice: 'tagNeedsServer' | null } {
  const old = r.applied === null;
  let loaded: readonly Loaded[];
  let notice: 'tagNeedsServer' | null = null;
  if (!isBoardPage(r)) {
    loaded = r.items.map((b) => ({ uid: b.uid, title: b.title, tags: [], updatedAt: null }));
  } else if (old && o.mode === 'tag') {
    loaded = [];
    notice = 'tagNeedsServer';
  } else if (old) {
    const q = asciiLower(o.q);
    loaded = r.items
      .filter((b) => asciiLower(b.title).includes(q))
      .map((b) => ({ uid: b.uid, title: b.title, tags: null, updatedAt: b.updatedAt }));
  } else {
    loaded = r.items.map((b) => ({
      uid: b.uid,
      title: b.title,
      tags: b.tags,
      updatedAt: b.updatedAt,
    }));
  }
  const titles = new Map<string, number>();
  for (const b of loaded) titles.set(b.title, (titles.get(b.title) ?? 0) + 1);
  const rows: BoardRow[] = loaded.map((b) => ({
    ...b,
    display: (titles.get(b.title) ?? 0) > 1 ? `${b.title} · ${b.uid}` : b.title,
    current: b.uid === o.currentUid,
  }));
  let unknown: Coverage['unknown'];
  if (old) unknown = { reason: 'oldServer' };
  else if (isBoardPage(r) && r.tagsStale > 0) unknown = { reason: 'tagsStale', count: r.tagsStale };
  const coverage = listCoverage(rows.length, o.shown, old ? false : r.truncated, null, unknown);
  return { snapshot: { key, rows, coverage, fetchedAtMs: o.nowMs }, notice };
}

/** A row's accessible name: `‹display›[, this board]` (T24-025). */
export function boardRowName(r: BoardRow): string {
  return r.current ? `${r.display}, ${t('boardList.thisBoard')}` : r.display;
}

/**
 * The T24-023 caption: `incidents` without investigations ranks in the default order and says so;
 * otherwise none. The order never depends on `sort` in this version.
 */
export function rankingCaption(
  sort: BoardListOptions['sort'],
  c: { readonly investigations: boolean },
): string | null {
  return sort === 'incidents' && !c.investigations ? t('boardList.ranking') : null;
}

/**
 * Every loaded row as `title,uid,tags,updated_at` (T24-026): tags `;`-joined, `unknown` when not
 * known, empty when none; `updated_at` ISO 8601 UTC, empty for Starred and Recent rows.
 */
export function boardListTable(s: ListSnapshot<BoardRow>): ListTable {
  return {
    columns: ['title', 'uid', 'tags', 'updated_at'],
    rows: s.rows.map((r) => ({
      key: r.uid,
      cells: [
        r.title,
        r.uid,
        r.tags === null ? 'unknown' : r.tags.join(';'),
        r.updatedAt === null ? '' : new Date(r.updatedAt).toISOString(),
      ],
    })),
  };
}
