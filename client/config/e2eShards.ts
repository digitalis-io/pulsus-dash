/**
 * The CI shards of the e2e suite (#130): each browser runs as four jobs. `kbd-a` and `kbd-b` take
 * the keyboard parts tagged `@kbd-a` and `@kbd-b`; `rest-b` takes the spec files of `REST_B_FILES`;
 * `rest` takes every other test. The four filters partition the suite, and `ci:e2e-complete` checks
 * that each listed test was in exactly one shard.
 */
export const E2E_SHARDS = ['kbd-a', 'kbd-b', 'rest', 'rest-b'] as const;
export type E2eShard = (typeof E2E_SHARDS)[number];

export interface ShardFilter {
  grep?: RegExp;
  grepInvert?: RegExp;
}

/**
 * Spec files (paths relative to testDir) that run in `rest-b`; never keyboard.spec.ts or
 * golden-gallery.spec.ts (the goldens stay in `rest`). Sorted. Chosen longest first from the webkit
 * `rest` report of run 45285529104: K5 alone (1 060 s) outweighed every other file together (866 s),
 * so all of them are here. A new spec file runs in `rest` until it is added.
 */
export const REST_B_FILES: readonly string[] = [
  'a11y-rooms.spec.ts',
  'app-layout.spec.ts',
  'asset-origin.spec.ts',
  'board-edit.spec.ts',
  'board-prefs.spec.ts',
  'board-promql.spec.ts',
  'board-thresholds.spec.ts',
  'chart-brush.spec.ts',
  'chart-hover.spec.ts',
  'chart-zoom.spec.ts',
  'coverage.spec.ts',
  'csp-violations.spec.ts',
  'deep-link.spec.ts',
  'explore-metrics.spec.ts',
  'fonts.spec.ts',
  'gallery-extreme.spec.ts',
  'log-stream.spec.ts',
  'panel-editor-dialog.spec.ts',
  'theme.spec.ts',
  'ticks-parity.spec.ts',
];

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A tag ends at a character that cannot continue it: `@kbd-a` is not `@kbd-ab`.
const KBD = /@kbd-[ab](?![\w-])/;
// Playwright matches `project file describe… title tags`: a listed file is a whole space-separated
// token, so `a<file>` is not `<file>`.
const FILES = `(^| )(${REST_B_FILES.map(escape).join('|')})( |$)`;

const FILTERS: Record<E2eShard, ShardFilter> = {
  'kbd-a': { grep: /@kbd-a(?![\w-])/ },
  'kbd-b': { grep: /@kbd-b(?![\w-])/ },
  'rest-b': { grep: new RegExp(FILES), grepInvert: KBD },
  rest: { grepInvert: new RegExp(`${KBD.source}|${FILES}`) },
};

const isShard = (name: string): name is E2eShard =>
  (E2E_SHARDS as readonly string[]).includes(name);

/** `E2E_SHARD` → the Playwright filter. Undefined or '' → {} (the whole suite); unknown → throws. */
export function shardFilter(name: string | undefined): ShardFilter {
  if (name === undefined || name === '') return {};
  if (!isShard(name)) throw new Error(`E2E_SHARD must be one of ${E2E_SHARDS.join(', ')}`);
  return { ...FILTERS[name] };
}
