/* eslint-disable @typescript-eslint/no-unused-vars -- stubs until the implementation (tests first) */
/** The browser run's view of the XSS corpus (#198 Part 3b): stub until the implementation. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CorpusCase } from '../src/security/sanitise/xssCorpus.ts';

export type SkipReason = 'entity' | 'varNotUrlSafe' | 'nul';

export interface E2eCase {
  id: string;
  digest: string;
  skip: SkipReason | null;
  images: readonly string[];
}

export const E2E_CASES_FILE = fileURLToPath(
  new URL('./fixtures/xss-e2e-cases.json', import.meta.url),
);

export function caseDigest(_c: CorpusCase): string {
  return '';
}

export function compareCases(
  _generated: readonly E2eCase[],
  _committed: readonly E2eCase[],
): string[] {
  return [];
}

export function readCommittedCases(file: string = E2E_CASES_FILE): E2eCase[] {
  return (JSON.parse(readFileSync(file, 'utf8')) as { cases: E2eCase[] }).cases;
}
