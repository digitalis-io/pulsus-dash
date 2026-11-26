/**
 * The list table, CSV and facts (plan #216 Part 1 §3.6, `unit:list-table-csv`; T24-026, VIZ-066):
 * the T24 §10.1 titles, the §10.5 guard block, B and S.
 */
import { describe, expect, it } from 'vitest';
import type { BoardListItem, BoardPage, BoardRef } from '../../api/types';
import { boardListFacts } from '../boardList/facts';
import { B, findS, NOW_MS, S } from '../boardList/fixtures';
import { boardListTable, boardSnapshot } from '../boardList/rows';
import { withStale } from './snapshot';
import { listCsv } from './table';

const search = (p: BoardPage, q = '') =>
  boardSnapshot(['k'], p, {
    mode: 'search',
    q,
    tag: null,
    currentUid: null,
    shown: 10,
    nowMs: NOW_MS,
  }).snapshot;

const starred = (items: readonly BoardRef[], old = false) =>
  boardSnapshot(
    ['starred', 'demo'],
    { items, truncated: false, applied: old ? null : {} },
    {
      mode: 'starred',
      q: '',
      tag: null,
      currentUid: null,
      shown: 10,
      nowMs: NOW_MS,
    },
  ).snapshot;

/** Each title and the cell its CSV row starts with (⏎ a real LF). */
const GUARD: readonly [string, string][] = [
  ['=SUM(1)', "'=SUM(1)"],
  ['+1', '+1'],
  ['+x', "'+x"],
  ['-prod', "'-prod"],
  ['@x', "'@x"],
  ['\tx', "'\tx"],
  ['\rx', `"'\rx"`],
  ['a,b', '"a,b"'],
  ['say "hi"', '"say ""hi"""'],
  ['ok', 'ok'],
  ['-1+2', "'-1+2"],
  ['1\n', '"1\n"'],
  ['-1\n', `"'-1\n"`],
  ['1 ', '1 '],
  ['+Infinity', '+Infinity'],
  ['-Infinity', '-Infinity'],
  ['-6.25', '-6.25'],
  ['1e5', '1e5'],
];

describe('unit:list-table-csv', () => {
  it('the guard block, through a search page', () => {
    const items: BoardListItem[] = GUARD.map(([title], i) => ({
      uid: `u-${String(i)}`,
      title,
      version: 1,
      updatedAt: '2026-11-26T12:00:00Z',
      updatedBy: 'Ada Admin',
      tags: [],
    }));
    const csv = listCsv(
      boardListTable(search({ items, truncated: false, applied: {}, tagsStale: 0 })),
    );
    expect(csv).toBe(
      [
        'title,uid,tags,updated_at',
        ...GUARD.map(([, cell], i) => `${cell},u-${String(i)},,2026-11-26T12:00:00.000Z`),
      ]
        .map((l) => `${l}\r\n`)
        .join(''),
    );
  });

  it('B: every loaded row, with empty tags and times', () => {
    const t = boardListTable(starred(B.items));
    expect(t.columns).toEqual(['title', 'uid', 'tags', 'updated_at']);
    expect(t.rows).toHaveLength(12);
    expect(t.rows[0]).toEqual({ key: 'ck-1', cells: ['Checkout', 'ck-1', '', ''] });
    expect(listCsv(t).split('\r\n')[8]).toBe('Payments,pay,,');
  });

  it('S: tags joined, times in ISO 8601 UTC; null tags are unknown', () => {
    const t = boardListTable(search(findS({ q: 'check' })));
    expect(t.rows.map((r) => r.cells)).toEqual([
      ['Checkout overview', 's-1', 'team:payments', '2026-11-26T12:00:00.000Z'],
      ['CHECKOUT latency', 's-2', '', '2026-11-26T11:59:00.000Z'],
    ]);
    const ledger = boardListTable(search(findS({ q: 'ledger' })));
    expect(ledger.rows[0]?.cells[2]).toBe('finance;team:payments');
    const stale = S.slice(0, 1).map((b) => ({ ...b, tags: null }));
    const u = boardListTable(search({ items: stale, truncated: false, applied: {}, tagsStale: 1 }));
    expect(u.rows[0]?.cells[2]).toBe('unknown');
  });

  it('facts', () => {
    expect(boardListFacts('Starred boards', 'starred', starred(B.items))).toEqual({
      subject: 'Starred boards',
      current: { text: '12 boards', series: 'Starred' },
      change: null,
      extent: null,
      baselineRatio: null,
    });
    expect(boardListFacts('All', 'search', search(findS({ q: 'bulk' })))?.current?.text).toBe(
      '1,000+ boards',
    );
    expect(boardListFacts('Old', 'starred', starred(B.items, true))?.current).toEqual({
      text: '12 boards (coverage unknown)',
      series: 'Starred',
    });
    const at = Date.parse('2026-11-26T12:31:05Z');
    expect(boardListFacts('S', 'recent', withStale(starred(B.items), at))?.current).toEqual({
      text: '12 boards (stale)',
      series: 'Recent',
    });
    expect(boardListFacts('S', 'tag', withStale(starred(B.items, true), at))?.current?.text).toBe(
      '12 boards (coverage unknown, stale)',
    );
    expect(boardListFacts('S', 'starred', null)).toBeNull();
  });
});
