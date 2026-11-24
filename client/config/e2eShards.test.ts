import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { E2E_SHARDS, REST_B_FILES, shardFilter, type ShardFilter } from './e2eShards.ts';

/** Playwright's selection: `grep` must match, `grepInvert` must not (title plus tags). */
const selects = (f: ShardFilter, title: string): boolean =>
  (f.grep === undefined || f.grep.test(title)) && !(f.grepInvert?.test(title) ?? false);

const shardsOf = (title: string): string[] =>
  E2E_SHARDS.filter((s) => selects(shardFilter(s), title));

describe('e2e shards (#130)', () => {
  it('shardFilter selects each test in exactly one shard', () => {
    expect(E2E_SHARDS).toEqual(['kbd-a', 'kbd-b', 'kbd-c', 'rest', 'rest-b']);
    const first = REST_B_FILES[0] ?? 'none.spec.ts';
    // What Playwright matches: `project file describe… title tags`.
    const want: [string, string][] = [
      ['chromium x.spec.ts t', 'rest'],
      ['chromium keyboard.spec.ts t @kbd', 'rest'],
      ['chromium keyboard.spec.ts t @kbd @kbd-a', 'kbd-a'],
      ['chromium keyboard.spec.ts t @kbd @kbd-b', 'kbd-b'],
      ['chromium keyboard.spec.ts t @kbd @kbd-c', 'kbd-c'],
      [`chromium ${first} t`, 'rest-b'],
      // A longer file name that ends in a listed one is not listed.
      [`chromium a${first} t`, 'rest'],
    ];
    for (const [title, shard] of want) expect(shardsOf(title), title).toEqual([shard]);
    // A longer tag is not the shard's.
    expect(selects(shardFilter('kbd-a'), 'x @kbd-ab')).toBe(false);
    expect(selects(shardFilter('kbd-c'), 'x @kbd-cd')).toBe(false);
  });

  it('REST_B_FILES are real, sorted, keyboard- and golden-free', () => {
    const specs = new Set(readdirSync(new URL('../e2e', import.meta.url)));
    expect(REST_B_FILES.length).toBeGreaterThan(0);
    for (const f of REST_B_FILES) {
      expect(f, f).toMatch(/\.spec\.ts$/);
      expect(specs.has(f), f).toBe(true);
    }
    expect([...REST_B_FILES]).toEqual([...REST_B_FILES].sort());
    expect(REST_B_FILES).not.toContain('keyboard.spec.ts');
    expect(REST_B_FILES).not.toContain('golden-gallery.spec.ts');
  });

  it('shardFilter: none is all, unknown throws', () => {
    expect(shardFilter(undefined)).toEqual({});
    expect(shardFilter('')).toEqual({});
    expect(() => shardFilter('kbd-d')).toThrow(
      'E2E_SHARD must be one of kbd-a, kbd-b, kbd-c, rest, rest-b',
    );
  });
});
