import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURE_DIR, fixtures } from './engine-fixtures.ts';

describe('unit:engine-fixtures', () => {
  it('committed engine/fixtures equal a fresh run', async () => {
    const files = await fixtures();
    expect(Object.keys(files).sort()).toEqual([
      'columns.json',
      'format.json',
      'layout.json',
      'palette.json',
      'pow.json',
      'summary.json',
      'synth.json',
      'ticks.json',
    ]);
    for (const [name, text] of Object.entries(files)) {
      let committed = '';
      try {
        committed = readFileSync(join(FIXTURE_DIR, name), 'utf8');
      } catch {
        committed = '';
      }
      expect(committed, `${name} is stale: run npm run engine-fixtures -- --write`).toBe(text);
    }
  }, 60_000);
});
