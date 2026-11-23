/**
 * The skips `ci:e2e-complete` accepts (#130, T05 §7.1): a test that ends `skipped` in a CI shard
 * report fails the check unless an entry here names its file, its title and the project, with the
 * reason. An entry that no run uses fails too (`e2e-skip-unused`).
 */
export interface AllowedSkip {
  /** The spec file, relative to `e2e/` (the JSON report's `spec.file`). */
  file: string;
  /** The test's own title (the last of its title path). */
  title: string;
  projects: readonly string[];
  reason: string;
}

export const ALLOWED_SKIPS: readonly AllowedSkip[] = [
  {
    file: 'log-stream.spec.ts',
    title: 'E6 touch: no scroll write during the gesture',
    projects: ['firefox', 'webkit'],
    reason: 'CDP touch events are Chromium only',
  },
];
