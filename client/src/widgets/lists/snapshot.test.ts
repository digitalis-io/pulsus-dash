/** List snapshots and the meter (plan #216 Part 1 §3.6, `unit:list-coverage`; T24-024, VIZ-027). */
import { describe, expect, it } from 'vitest';
import type { BoardPage } from '../../api/types';
import { coverageText } from '../../vis/reduce';
import { B, findS, NOW_MS } from '../boardList/fixtures';
import { boardSnapshot } from '../boardList/rows';
import { listCoverage, listSetSize, withStale, type ListSnapshot } from './snapshot';

const text = (...a: Parameters<typeof listCoverage>) => coverageText(listCoverage(...a), 'UTC');

function snap(loaded: number, shown: number, truncated = false): ListSnapshot<number> {
  return {
    key: ['k'],
    rows: Array.from({ length: loaded }, (_, i) => i),
    coverage: listCoverage(loaded, shown, truncated, null),
    fetchedAtMs: NOW_MS,
  };
}

describe('unit:list-coverage', () => {
  it('the meter text of a list', () => {
    expect(text(12, 10, false, null)).toBe('showing 10 of 12');
    expect(text(12, 12, false, null)).toBe('100 %');
    expect(text(1000, 10, true, null)).toBe('truncated · showing 10 of 1,000');
    expect(text(0, 0, false, null)).toBe('100 %');
    expect(text(3, 3, false, null, { reason: 'oldServer' })).toBe('coverage unknown');
    expect(text(3, 20, false, null)).toBe('100 %');
  });

  it('the coverage holds only the list members', () => {
    const c = listCoverage(12, 10, true, 5, { reason: 'oldServer' });
    expect(c).toEqual({
      total: 12,
      drawn: 10,
      keptMin: false,
      keptMax: false,
      keptWorst: 0,
      omittedWorst: 0,
      worstState: null,
      outside: 0,
      duplicates: 0,
      conflicts: 0,
      query: {
        truncated: true,
        warnings: [],
        infos: [],
        queryId: null,
        dataAgeMs: null,
        readCache: null,
        readCacheThroughMs: null,
      },
      baseline: null,
      unknown: { reason: 'oldServer' },
      staleAtMs: 5,
    });
    expect('unknown' in listCoverage(1, 1, false, null)).toBe(false);
  });

  it('tags not yet known, through boardSnapshot', () => {
    const page = (n: number, tagsStale: number): BoardPage => {
      const p = findS({ q: 'z' });
      return { ...p, items: p.items.slice(0, n), tagsStale };
    };
    const meter = (p: BoardPage) =>
      coverageText(
        boardSnapshot(['k'], p, {
          mode: 'search',
          q: 'z',
          tag: null,
          currentUid: null,
          shown: 10,
          nowMs: NOW_MS,
        }).snapshot.coverage,
        'UTC',
      );
    expect(meter(page(2, 1))).toBe('tags not yet known for 1 board');
    expect(meter(page(2, 3))).toBe('tags not yet known for 3 boards');
    expect(meter(page(2, 0))).toBe('100 %');
  });

  it('a failed refetch keeps the snapshot with its stale time', () => {
    const s = snap(12, 10);
    const stale = withStale(s, Date.parse('2026-11-26T12:31:05Z'));
    expect(coverageText(stale.coverage, 'UTC')).toBe('showing 10 of 12 · stale (12:31:05)');
    expect(stale.rows).toBe(s.rows);
    expect(s.coverage.staleAtMs).toBeNull();
  });

  it('the set size is the loaded count, or −1 when truncated or unknown', () => {
    const b = boardSnapshot(['starred', 'demo'], B, {
      mode: 'starred',
      q: '',
      tag: null,
      currentUid: null,
      shown: 10,
      nowMs: NOW_MS,
    }).snapshot;
    expect(listSetSize(b)).toBe(12);
    expect(listSetSize(snap(12, 10, true))).toBe(-1);
    expect(
      listSetSize({ ...b, coverage: listCoverage(12, 10, false, null, { reason: 'oldServer' }) }),
    ).toBe(-1);
  });
});
