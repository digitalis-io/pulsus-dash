/**
 * The parts of the `e2e:a11y-rooms` keyboard script (#130): five independent tests, each writing the
 * controls it collected and operated and the states it visited to one JSON file. The coverage rule
 * (IA-015) holds over the union of the five files (`scripts/keyboard-coverage.ts`), so a part can run
 * in any CI shard. No imports: the spec, the checker scripts and the reporter share it.
 */
export const KEYBOARD_PARTS = ['K1', 'K2', 'K3', 'K4', 'K5'] as const;
export type KeyboardPart = (typeof KEYBOARD_PARTS)[number];

/**
 * The parts in the single test's loop order (before #130 split it): L1–L22, L23–L24 b-1,
 * L24 b-3…L26, L27, L28–L32.
 */
export const SINGLE_TEST_ORDER: readonly KeyboardPart[] = ['K1', 'K3', 'K4', 'K2', 'K5'];

/** The tag every part carries; `@kbd-a` and `@kbd-b` pick the parts of the two keyboard shards. */
export const KEYBOARD_TAG = '@kbd';

/** `K3 board list…` → 'K3'; anything else → undefined. */
export function partOfTitle(title: string): KeyboardPart | undefined {
  const m = /^(K[1-5]) /.exec(title);
  return m === null ? undefined : (m[1] as KeyboardPart);
}

/** The states every full run must visit (the route patterns, `not-found` and `session-error`). */
export const REQUIRED_STATES: readonly string[] = [
  '/t/:tenant/boards',
  '/t/:tenant/board/:uid',
  '/t/:tenant/explore/metrics',
  '/t/:tenant/explore/logs',
  '/t/:tenant/admin',
  '/t/:tenant/dev/gallery',
  '/signed-out',
  'not-found',
  'session-error',
];

const BOARD = '/t/:tenant/board/:uid + none ›';

/**
 * Keys a part's drains treat as done because an earlier part (`SINGLE_TEST_ORDER`) operates them,
 * as the single test's drains did. Never added to the part's `operated`; the coverage checker
 * fails a key no earlier part operated (`keyboard-skip-unbacked`) or the part did not collect
 * (`keyboard-skip-unused`).
 */
export const DRAIN_SKIP: Readonly<Record<KeyboardPart, readonly string[]>> = {
  K1: [],
  K3: [],
  // Operated by K3 (L24 b-1).
  K4: ['Request rate', 'Error ratio', 'Errors', 'Request latency'].map(
    (t) => `${BOARD} link "Open in Explore: ${t}"`,
  ),
  K2: [
    // Operated by K3 and K4.
    `${BOARD} button "Add panel"`,
    // Operated by K3 (L24 b-1).
    `${BOARD} button "Share"`,
    // Operated by K4 (L24 b-3).
    `${BOARD} button "Full screen: Edge p99"`,
  ],
  // Operated by K3 and K4 (L25).
  K5: [`${BOARD} button "Share"`],
};

/** `keys` of `state` whose `${state} › ${k}` is neither in `operated` nor in `done`, in order. */
export function drainPending(
  keys: readonly string[],
  state: string,
  operated: ReadonlySet<string>,
  done: ReadonlySet<string>,
): string[] {
  return keys.filter((k) => {
    const key = `${state} › ${k}`;
    return !operated.has(key) && !done.has(key);
  });
}

/** Under the project's outputDir (test-results/), which Playwright empties at run start. */
export const COVERAGE_DIR = 'keyboard-coverage';

export const coverageFileName = (project: string, part: KeyboardPart): string =>
  `${project}-${part}.json`;

/** One part's file. Every list is sorted; keys are `state › role "name"`. */
export interface PartCoverage {
  version: 1;
  project: string;
  part: KeyboardPart;
  collected: string[];
  operated: string[];
  /** Route states. */
  visited: string[];
}
