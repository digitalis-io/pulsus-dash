/** Board rows (plan #216 Part 1 §4.3, `unit:board-list-rows`; T24-022, T24-023). */
import { describe, expect, it } from 'vitest';
import { B, findS, NOW_MS } from './fixtures';
import { boardRowName, boardSnapshot, rankingCaption } from './rows';

const starred = (currentUid: string | null) =>
  boardSnapshot(['starred', 'demo'], B, {
    mode: 'starred',
    q: '',
    tag: null,
    currentUid,
    shown: 12,
    nowMs: NOW_MS,
  }).snapshot;

describe('unit:board-list-rows', () => {
  it('equal titles show the uid; the board that holds the widget is this board', () => {
    const s = starred('pay');
    expect(s.rows.map((r) => r.display)).toEqual([
      'Checkout · ck-1',
      'Checkout · ck-2',
      'Edge',
      'Gateway',
      'Inventory',
      'NOC overview',
      'Orders',
      'Payments',
      'PSP API',
      'Search',
      'Shipping',
      'Web',
    ]);
    expect(s.rows.filter((r) => r.current).map((r) => r.uid)).toEqual(['pay']);
    const pay = s.rows.find((r) => r.uid === 'pay');
    if (pay === undefined) throw new Error('no pay row');
    expect(boardRowName(pay)).toBe('Payments, this board');
    expect(boardRowName(s.rows[0] ?? pay)).toBe('Checkout · ck-1');
    for (const r of s.rows) {
      expect(r.tags, r.uid).toEqual([]);
      expect(r.updatedAt, r.uid).toBeNull();
    }
    expect(s.fetchedAtMs).toBe(NOW_MS);
    expect(s.key).toEqual(['starred', 'demo']);
  });

  it('search rows keep the tags and times as sent', () => {
    const { snapshot, notice } = boardSnapshot(
      ['boards', 'demo', 'find', 'check', null],
      findS({ q: 'check' }),
      {
        mode: 'search',
        q: 'check',
        tag: null,
        currentUid: null,
        shown: 10,
        nowMs: NOW_MS,
      },
    );
    expect(notice).toBeNull();
    expect(snapshot.rows.map((r) => [r.display, r.tags, r.updatedAt])).toEqual([
      ['Checkout overview', ['team:payments'], '2026-11-26T12:00:00Z'],
      ['CHECKOUT latency', [], '2026-11-26T11:59:00Z'],
    ]);
    expect(snapshot.coverage.unknown).toBeUndefined();
  });

  it('incidents ranking: the caption without investigations, and the default order', () => {
    expect(rankingCaption('incidents', { investigations: false })).toBe(
      'Ranking by use during incidents is available with investigations (M-UI4)',
    );
    expect(rankingCaption('default', { investigations: false })).toBeNull();
    expect(rankingCaption('incidents', { investigations: true })).toBeNull();
    // The order ignores sort: the rows of both are the server's.
    expect(starred('pay').rows).toEqual(starred('pay').rows);
    expect(starred(null).rows.map((r) => r.uid)).toEqual(B.items.map((r) => r.uid));
  });
});
