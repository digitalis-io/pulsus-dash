/**
 * unit:xss-corpus-current (plan #198 Part 2b §5, §5.1): the committed XSS corpus equals a fresh
 * generation, and a changed expectation is caught (exit 1), in-process and through the CLI.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { check, CORPUS_FILE, corpusText } from './gen-xss-corpus.ts';

const SCRIPT = fileURLToPath(new URL('./gen-xss-corpus.ts', import.meta.url));

describe('unit:xss-corpus-current', () => {
  it('the committed corpus equals a fresh generation', async () => {
    const fresh = await corpusText();
    const committed = readFileSync(CORPUS_FILE, 'utf8');
    expect(committed, 'stale: run npm run gen:xss-corpus').toBe(fresh);
    expect(check(committed, fresh)).toBe(0);
  }, 60_000);

  it('one changed expectation exits 1', async () => {
    const fresh = await corpusText();
    const doc = JSON.parse(fresh) as {
      cases: { expect: { board: { removals: [string, number][] } } }[];
    };
    const first = doc.cases[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    first.expect.board.removals = [...first.expect.board.removals, ['html', 99]];
    expect(check(`${JSON.stringify(doc, null, 1)}\n`, fresh)).toBe(1);
  }, 60_000);

  it('the CLI --check exits 0 on the committed corpus', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--check'], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  }, 60_000);
});
