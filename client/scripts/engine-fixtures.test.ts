import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURE_DIR, fixtures, GALLERY_WINDOW, PARITY_LINE_IDS } from './engine-fixtures.ts';

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

  it('parity fixtures use the allowlist only', async () => {
    const files = await fixtures();
    const ids = (name: string): unknown[] =>
      (JSON.parse(files[name] ?? '[]') as { id?: unknown }[])
        .map((r) => r.id)
        .filter((id) => id !== undefined);
    expect(PARITY_LINE_IDS).toEqual(['line-1', 'line-50', 'line-gaps', 'line-600']);
    for (const name of ['layout.json', 'synth.json', 'summary.json']) {
      expect(ids(name), name).toEqual([...PARITY_LINE_IDS]);
    }
    // Loaded as the generator loads client modules (their types are not part of this project).
    const galleryPath = '../src/dev/gallery.ts';
    const { galleryEntries } = (await import(galleryPath)) as {
      galleryEntries: (w: typeof GALLERY_WINDOW) => { id: string }[];
    };
    const gallery = galleryEntries(GALLERY_WINDOW).map((e) => e.id);
    expect(gallery).toContain('line-thresholds');
    for (const name of ['layout.json', 'synth.json', 'summary.json']) {
      expect(ids(name), name).not.toContain('line-thresholds');
    }
  }, 60_000);

  it('summary.json keeps the parity fields only', async () => {
    const files = await fixtures();
    const rows = JSON.parse(files['summary.json'] ?? '[]') as { summary: object }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(Object.keys(r.summary).sort()).toEqual(
        [
          'kind',
          'seriesTotal',
          'seriesShown',
          'fromMs',
          'toMs',
          'min',
          'max',
          'last',
          'plot',
          'valueAxis',
        ].sort(),
      );
    }
  }, 60_000);
});
