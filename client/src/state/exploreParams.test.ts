import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXPLORE,
  normalisedExploreSearch,
  readExploreParams,
  writeExploreParams,
} from './exploreParams';

const ENV = { nowMs: Date.UTC(2026, 10, 19, 13, 3), timeZone: 'Europe/London' };

describe('unit:explore-params', () => {
  it('reads q, vis and rate', () => {
    expect(readExploreParams([['q', 'up']])).toEqual({ q: 'up', vis: 'auto', rate: 'auto' });
    expect(
      readExploreParams([
        ['q', 'up'],
        ['q', 'x'],
      ]).q,
    ).toBe('up');
    expect(
      readExploreParams([
        ['vis', 'pie'],
        ['vis', 'bars'],
      ]).vis,
    ).toBe('bars');
    expect(readExploreParams([['rate', 'on']]).rate).toBe('auto');
    expect(readExploreParams([['rate', 'off']]).rate).toBe('off');
    expect(readExploreParams([['q', '']]).q).toBe('');
  });

  it('writes the non-default keys, sorted with the rest', () => {
    expect(
      writeExploreParams(
        [
          ['a', '1'],
          ['zz', '2'],
        ],
        { q: 'sum(up)', vis: 'bars', rate: 'off' },
      ),
    ).toEqual([
      ['a', '1'],
      ['q', 'sum(up)'],
      ['rate', 'off'],
      ['vis', 'bars'],
      ['zz', '2'],
    ]);
    expect(
      writeExploreParams(
        [
          ['q', 'x'],
          ['vis', 'line'],
        ],
        DEFAULT_EXPLORE,
      ),
    ).toEqual([]);
  });

  it('normalises to the canonical search', () => {
    expect(normalisedExploreSearch('?from=now-1h&to=now&refresh=off&vis=pie&q=up&q=x', ENV)).toBe(
      '?from=now-1h&to=now&refresh=off&q=up',
    );
    expect(normalisedExploreSearch('?from=now-1h&to=now&refresh=off&q=a+b', ENV)).toBeNull();
    expect(
      normalisedExploreSearch('?from=now-1h&to=now&refresh=off&q=up&rate=off&vis=stat', ENV),
    ).toBeNull();
  });
});
