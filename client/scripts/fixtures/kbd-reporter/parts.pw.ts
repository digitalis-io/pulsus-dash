/**
 * Five `@kbd` parts that write part files without a browser (#130, test 12). `KBD_FIXTURE`:
 * `covered` (every collected key operated), `uncovered` (`b › k` never operated), `no-k4` (K4 not
 * declared).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from '@playwright/test';
import {
  COVERAGE_DIR,
  coverageFileName,
  KEYBOARD_PARTS,
  REQUIRED_STATES,
  type PartCoverage,
} from '../../../e2e/keyboardParts.ts';

const fixture = process.env['KBD_FIXTURE'] ?? 'covered';

for (const [i, id] of KEYBOARD_PARTS.entries()) {
  if (fixture === 'no-k4' && id === 'K4') continue;
  // Playwright requires a destructuring pattern for the fixtures argument, even an empty one.
  // eslint-disable-next-line no-empty-pattern
  test(`${id} x`, { tag: ['@kbd'] }, ({}, info) => {
    const operated = fixture === 'uncovered' ? ['a › k'] : ['a › k', 'b › k'];
    const coverage: PartCoverage = {
      version: 1,
      project: info.project.name,
      part: id,
      collected: id === 'K1' ? ['a › k', 'b › k'] : [],
      operated: id === 'K5' ? operated : [],
      visited: REQUIRED_STATES.filter((_, j) => j % KEYBOARD_PARTS.length === i),
    };
    const dir = join(info.project.outputDir, COVERAGE_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, coverageFileName(info.project.name, id)), JSON.stringify(coverage));
  });
}
