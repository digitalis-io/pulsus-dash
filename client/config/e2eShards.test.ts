import { describe, expect, it } from 'vitest';
import { E2E_SHARDS, shardFilter, type ShardFilter } from './e2eShards.ts';

/** Playwright's selection: `grep` must match, `grepInvert` must not (title plus tags). */
const selects = (f: ShardFilter, title: string): boolean =>
  (f.grep === undefined || f.grep.test(title)) && !(f.grepInvert?.test(title) ?? false);

describe('e2e shards (#130)', () => {
  it('shardFilter selects each tag set in exactly one shard', () => {
    for (const title of ['x', 'x @kbd', 'x @kbd @kbd-a', 'x @kbd @kbd-b']) {
      const by = E2E_SHARDS.filter((s) => selects(shardFilter(s), title));
      expect(by, title).toHaveLength(1);
    }
    expect(selects(shardFilter('kbd-a'), 'x @kbd @kbd-a')).toBe(true);
    expect(selects(shardFilter('kbd-b'), 'x @kbd @kbd-b')).toBe(true);
    expect(selects(shardFilter('rest'), 'x @kbd')).toBe(true);
    expect(selects(shardFilter('rest'), 'x')).toBe(true);
    // A longer tag is not the shard's.
    expect(selects(shardFilter('kbd-a'), 'x @kbd-ab')).toBe(false);
  });

  it('shardFilter: none is all, unknown throws', () => {
    expect(shardFilter(undefined)).toEqual({});
    expect(shardFilter('')).toEqual({});
    expect(() => shardFilter('kbd-c')).toThrow('E2E_SHARD must be one of kbd-a, kbd-b, rest');
  });
});
