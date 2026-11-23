/**
 * The parts of the `e2e:a11y-rooms` keyboard script (#130): five independent tests, each writing the
 * controls it collected and operated and the states it visited to one JSON file. The coverage rule
 * (IA-015) holds over the union of the five files (`scripts/keyboard-coverage.ts`), so a part can run
 * in any CI shard. No imports: the spec, the checker scripts and the reporter share it.
 */
export const KEYBOARD_PARTS = ['K1', 'K2', 'K3', 'K4', 'K5'] as const;
export type KeyboardPart = (typeof KEYBOARD_PARTS)[number];

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
