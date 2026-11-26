/** Board list import (plan #216 Part 1 §4.4, `unit:import-board-list`; T24-028, T24 §4.6, VIZ-060). */
import { describe, expect, it } from 'vitest';
import type { BoardListOptions } from '../widgets/boardList/options';
import { importBoardList } from './boardList';

const base: BoardListOptions = {
  mode: 'starred',
  query: '',
  tag: null,
  limit: 10,
  sort: 'default',
};

const cases: readonly [string, Record<string, unknown>, Partial<BoardListOptions>, string[]][] = [
  ['I1', {}, {}, []],
  [
    'I2',
    { showStarred: true, showRecentlyViewed: true, maxItems: 80 },
    { limit: 50 },
    [
      'Only the first list (starred) kept: add another Board list for recent',
      'Item limit 80 clamped to 50',
    ],
  ],
  [
    'I3',
    { showStarred: false, showSearch: true, tags: ['Team-A', 'b c', 'ops'], query: 'x' },
    { mode: 'tag', tag: 'team-a' },
    [
      'Tag ‘b c’ dropped: not a valid tag',
      'Tags not kept: ops (a board list filters by one tag)',
      'Search text dropped in tag mode',
    ],
  ],
  [
    'I4',
    { showStarred: false, showSearch: true, query: 'a'.repeat(120) },
    { mode: 'search', query: 'a'.repeat(100) },
    ['Search text cut to 100 characters'],
  ],
  [
    'I5',
    { showStarred: 'yes', maxItems: 'many', keepTime: false, folderUID: 'abc', includeVars: true },
    {},
    [
      'Option showStarred malformed: default used',
      'Option maxItems malformed: default used',
      'Links keep the time range',
      'Option folderUID not mapped',
      'Option includeVars not mapped',
    ],
  ],
  [
    'I6',
    { showStarred: false, showRecentlyViewed: false, showSearch: false },
    {},
    ['No list enabled: starred used'],
  ],
  [
    'I7',
    { showStarred: false, showSearch: true, tags: ['!!'] },
    { mode: 'search' },
    ['Tag ‘!!’ dropped: not a valid tag'],
  ],
  [
    'I8',
    { showRecentlyViewed: false, query: 'x', maxItems: 0 },
    { limit: 1 },
    ['Search text and tags dropped: they apply to search only', 'Item limit 0 clamped to 1'],
  ],
  [
    'I9',
    { showStarred: false, showSearch: true, query: 'a\tb\u0007c' },
    { mode: 'search', query: 'abc' },
    ['Control characters removed from search text'],
  ],
  [
    'I10',
    { showSearch: 'yes', showStarred: false },
    {},
    ['No list enabled: starred used', 'Option showSearch malformed: default used'],
  ],
  ['I11', { maxItems: 2.5 }, {}, ['Option maxItems malformed: default used']],
  [
    'I12',
    { showStarred: false, showSearch: true, tags: ['A', 'a', 'b', 'B'] },
    { mode: 'tag', tag: 'a' },
    ['Tags not kept: b (a board list filters by one tag)'],
  ],
];

describe('unit:import-board-list', () => {
  it.each(cases)('%s', (_name, src, options, notes) => {
    expect(importBoardList(src)).toEqual({ options: { ...base, ...options }, notes });
  });

  it('several extra lists are joined', () => {
    expect(
      importBoardList({ showStarred: true, showRecentlyViewed: true, showSearch: true }).notes,
    ).toEqual(['Only the first list (starred) kept: add another Board list for recent and search']);
  });
});
