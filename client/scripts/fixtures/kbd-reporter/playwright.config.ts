/**
 * The keyboard coverage reporter under a real `playwright test` (#130, test 12): no browser and no
 * web server. `parts.pw.ts` writes the part files `KBD_FIXTURE` selects into `KBD_FIXTURE_OUT`.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'parts.pw.ts',
  outputDir: process.env['KBD_FIXTURE_OUT'] ?? join(tmpdir(), 'kbd-reporter-fixture'),
  retries: 0,
  reporter: [['list'], ['../../keyboard-coverage-reporter.ts']],
  projects: [{ name: 'fixture' }],
});
