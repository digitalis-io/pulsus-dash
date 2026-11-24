import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  E2E_SHARDS,
  E2E_TIMEOUTS,
  REST_B_FILES,
  shardFilter,
  type ShardFilter,
} from './e2eShards.ts';

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

  it('timeouts nest with margin', () => {
    const t = E2E_TIMEOUTS;
    expect(t.partMin).toBeLessThan(t.globalMin);
    expect(t.setupMaxMin + t.globalMin + t.tailMin).toBeLessThanOrEqual(t.jobMin);
    expect(t.partMin).toBeGreaterThanOrEqual(30);
    // The e2e job's own timeout-minutes, from its block of the workflow.
    const yml = readFileSync(
      new URL('../../.github/workflows/client.yml', import.meta.url),
      'utf8',
    );
    const block = /\n {2}e2e:\n([\s\S]*?)\n {2}[a-z][\w-]*:\n/.exec(yml)?.[1] ?? '';
    const job = /\n {4}timeout-minutes: (\d+)\n/.exec(`\n${block}\n`)?.[1];
    expect(Number(job)).toBe(t.jobMin);
  });

  it('spec and config use E2E_TIMEOUTS', () => {
    const read = (p: string): string => readFileSync(new URL(p, import.meta.url), 'utf8');
    const spec = read('../e2e/keyboard.spec.ts');
    const config = read('../playwright.config.ts');
    expect(spec).toContain('E2E_TIMEOUTS.partMin');
    expect(config).toContain('E2E_TIMEOUTS.globalMin');
    for (const text of [spec, config]) {
      expect(text).not.toContain('22 * 60_000');
      expect(text).not.toContain('25 * 60_000');
    }
  });
});
