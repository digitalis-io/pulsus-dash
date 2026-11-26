/**
 * The import of a dashboard list panel's options as a board list (plan #216 Part 1 §4.4; T24-028,
 * T24 §4.6, VIZ-060): the options, and one report note per absent-but-meaningful, malformed,
 * dropped, cut or clamped option, in the T24 §4.6 order. Pure; the import pipeline (#158, #17)
 * calls it.
 */
import type { BoardListMode } from '../api/types';
import { BOARD_LIMIT, MAX_BOARD_QUERY } from '../boards/options';
import { TAG_PATTERN } from '../boards/spec';
import { DEFAULT_BOARD_LIMIT, type BoardListOptions } from '../widgets/boardList/options';

/** The source keys this import reads, in the order their malformed notes are reported. */
const KNOWN = [
  'showStarred',
  'showRecentlyViewed',
  'showSearch',
  'maxItems',
  'query',
  'tags',
  'keepTime',
] as const;
type Known = (typeof KNOWN)[number];

interface Source {
  readonly showStarred: boolean;
  readonly showRecentlyViewed: boolean;
  readonly showSearch: boolean;
  readonly maxItems: number;
  readonly query: string;
  readonly tags: readonly string[];
  readonly keepTime: boolean;
}

const DEFAULTS: Source = {
  showStarred: true,
  showRecentlyViewed: false,
  showSearch: false,
  maxItems: DEFAULT_BOARD_LIMIT,
  query: '',
  tags: [],
  keepTime: true,
};

/** Whether `v` has the type of source key `k`. */
function wellFormed(k: Known, v: unknown): boolean {
  switch (k) {
    case 'maxItems':
      return Number.isInteger(v);
    case 'query':
      return typeof v === 'string';
    case 'tags':
      return Array.isArray(v) && v.every((x) => typeof x === 'string');
    default:
      return typeof v === 'boolean';
  }
}

/** C0 and C1 control characters (U+0000–001F, U+007F–009F). */
// eslint-disable-next-line no-control-regex -- the T24 §4.6 rule removes exactly these
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;

/** ASCII-only lower case, as the board search folds. */
function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** The board list options of a dashboard list panel's `src` options, and the report notes. */
export function importBoardList(src: Readonly<Record<string, unknown>>): {
  readonly options: BoardListOptions;
  readonly notes: readonly string[];
} {
  const malformed: string[] = [];
  const read = <K extends Known>(k: K): Source[K] => {
    if (!Object.hasOwn(src, k)) return DEFAULTS[k];
    const v = src[k];
    if (wellFormed(k, v)) return v as Source[K];
    malformed.push(`Option ${k} malformed: default used`);
    return DEFAULTS[k];
  };
  const showStarred = read('showStarred');
  const showRecent = read('showRecentlyViewed');
  const showSearch = read('showSearch');
  const maxItems = read('maxItems');
  const query = read('query');
  const tags = read('tags');
  const keepTime = read('keepTime');

  const notes: string[] = [];
  const lists: readonly [BoardListMode, boolean][] = [
    ['starred', showStarred],
    ['recent', showRecent],
    ['search', showSearch],
  ];
  const enabled = lists.filter(([, on]) => on).map(([m]) => m);
  let mode: BoardListMode = enabled[0] ?? 'starred';
  if (enabled.length === 0) notes.push('No list enabled: starred used');
  else if (enabled.length > 1) {
    const more = enabled.slice(1).join(' and ');
    notes.push(`Only the first list (${mode}) kept: add another Board list for ${more}`);
  }
  notes.push(...malformed);

  let q = '';
  let tag: string | null = null;
  if (mode === 'search') {
    const valid: string[] = [];
    for (const raw of tags) {
      const lower = asciiLower(raw);
      if (!TAG_PATTERN.test(lower)) notes.push(`Tag ‘${raw}’ dropped: not a valid tag`);
      else if (!valid.includes(lower)) valid.push(lower);
    }
    const first = valid[0];
    if (first !== undefined) {
      mode = 'tag';
      tag = first;
      const rest = valid.slice(1);
      if (rest.length > 0) {
        notes.push(`Tags not kept: ${rest.join(', ')} (a board list filters by one tag)`);
      }
      if (query !== '') notes.push('Search text dropped in tag mode');
    } else {
      q = query.replace(CONTROLS, '');
      if (q !== query) notes.push('Control characters removed from search text');
      const points = Array.from(q);
      if (points.length > MAX_BOARD_QUERY) {
        q = points.slice(0, MAX_BOARD_QUERY).join('');
        notes.push(`Search text cut to ${String(MAX_BOARD_QUERY)} characters`);
      }
    }
  } else if (query !== '' || tags.length > 0) {
    notes.push('Search text and tags dropped: they apply to search only');
  }

  const limit = Math.min(Math.max(maxItems, BOARD_LIMIT.min), BOARD_LIMIT.max);
  if (limit !== maxItems) notes.push(`Item limit ${String(maxItems)} clamped to ${String(limit)}`);
  if (!keepTime) notes.push('Links keep the time range');
  const known: readonly string[] = KNOWN;
  const other = Object.keys(src)
    .filter((k) => !known.includes(k))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const k of other) notes.push(`Option ${k} not mapped`);

  return { options: { mode, query: q, tag, limit, sort: 'default' }, notes };
}
