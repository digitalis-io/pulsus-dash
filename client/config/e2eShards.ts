/**
 * The CI shards of the e2e suite (#130): each browser runs as three jobs, chosen by tag. `kbd-a` and
 * `kbd-b` take the keyboard parts tagged `@kbd-a` and `@kbd-b`; `rest` takes every other test. The
 * three filters partition the suite, and `ci:e2e-complete` checks that they did.
 */
export const E2E_SHARDS = ['kbd-a', 'kbd-b', 'rest'] as const;
/** Spec files (paths relative to testDir) that run in `rest-b`. */
export const REST_B_FILES: readonly string[] = [];

export type E2eShard = (typeof E2E_SHARDS)[number];

export interface ShardFilter {
  grep?: RegExp;
  grepInvert?: RegExp;
}

// A tag ends at a character that cannot continue it: `@kbd-a` is not `@kbd-ab`.
const FILTERS: Record<E2eShard, ShardFilter> = {
  'kbd-a': { grep: /@kbd-a(?![\w-])/ },
  'kbd-b': { grep: /@kbd-b(?![\w-])/ },
  rest: { grepInvert: /@kbd-[ab](?![\w-])/ },
};

const isShard = (name: string): name is E2eShard =>
  (E2E_SHARDS as readonly string[]).includes(name);

/** `E2E_SHARD` → the Playwright filter. Undefined or '' → {} (the whole suite); unknown → throws. */
export function shardFilter(name: string | undefined): ShardFilter {
  if (name === undefined || name === '') return {};
  if (!isShard(name)) throw new Error(`E2E_SHARD must be one of ${E2E_SHARDS.join(', ')}`);
  return { ...FILTERS[name] };
}
