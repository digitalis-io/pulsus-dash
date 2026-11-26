/**
 * unit:xss-e2e-cases (plan #198 Part 3b §5): the committed browser case list is current (`--check`,
 * in-process and through the CLI) and a changed expectation is caught; the baseline comparison of
 * `loadWatch` names a changed count (c13); a changed source under the same id changes its digest
 * (c14); the image extraction and the skip reasons.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compareBaseline, readBaseline } from '../e2e/loadWatch.ts';
import { compareCases, E2E_CASES_FILE, readCommittedCases } from '../e2e/xssCases.ts';
import type { CorpusCase } from '../src/security/sanitise/xssCorpus.ts';
import {
  casesText,
  check,
  corpusInput,
  generate,
  imagePaths,
  loadCheckParamValue,
  skipOf,
} from './gen-xss-e2e-cases.ts';

const SCRIPT = fileURLToPath(new URL('./gen-xss-e2e-cases.ts', import.meta.url));

const kase = (src: string, more: Partial<CorpusCase> = {}): CorpusCase => ({
  id: 'T1',
  group: 'T',
  src,
  vars: [['env', 'prod']],
  entity: null,
  ...more,
});

describe('unit:xss-e2e-cases', () => {
  it('the committed list equals a fresh generation; a changed expectation exits 1', async () => {
    const fresh = await generate();
    const committed = readFileSync(E2E_CASES_FILE, 'utf8');
    expect(compareCases(fresh, readCommittedCases())).toEqual([]);
    expect(committed, 'stale: run npm run gen:xss-e2e-cases').toBe(casesText(fresh));
    expect(check(committed, fresh)).toBe(0);
    const doc = JSON.parse(committed) as { cases: { images: string[] }[] };
    const first = doc.cases[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    first.images = [...first.images, '/changed.svg'];
    expect(check(`${JSON.stringify(doc, null, 1)}\n`, fresh)).toBe(1);
  }, 60_000);

  it('the CLI --check exits 0 on the committed list', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--check'], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  }, 60_000);

  it('c13: a recorded map with one count incremented fails, naming that key', () => {
    const committed = readBaseline('chromium');
    const key = Object.keys(committed).find((k) => k.startsWith('GET fetch /api/dash/v1/boards/'));
    expect(key).toBeDefined();
    if (key === undefined) return;
    const recorded = { ...committed, [key]: (committed[key] ?? 0) + 1 };
    expect(compareBaseline(recorded, committed)).toEqual([
      `${key}: recorded ${String((committed[key] ?? 0) + 1)}, committed ${String(committed[key] ?? 0)}`,
    ]);
    expect(compareBaseline(committed, committed)).toEqual([]);
  });

  it('c14: one source changed under the same id is one difference, its digest', async () => {
    const corpus = corpusInput();
    const i = corpus.findIndex((c) => c.group === 'H');
    const changed = corpus.map((c, j) => (j === i ? { ...c, src: `${c.src} ` } : c));
    const id = corpus[i]?.id ?? '';
    expect(compareCases(await generate(changed), readCommittedCases())).toEqual([`${id}: digest`]);
  }, 60_000);

  it('extracts the image request paths independently of the renderer', () => {
    expect(imagePaths(kase('![a](/l.svg)'))).toEqual(['/l.svg']);
    expect(imagePaths(kase('![a](/b?q=$v)', { vars: [['v', 'a b']] }))).toEqual(['/b?q=a%20b']);
    expect(imagePaths(kase('![a](/x/../l.svg)'))).toEqual(['/l.svg']);
    expect(imagePaths(kase('![a](/api/x)'))).toEqual([]);
    expect(imagePaths(kase('[![i](/l.svg) t](/b)'))).toEqual(['/l.svg']);
    expect(imagePaths(kase('[![i](https://i.test/x.png) t](/b)'))).toEqual([]);
    expect(imagePaths(kase('![a ![b](/l.svg)](https://i.test/x.png)'))).toEqual([]);
    expect(imagePaths(kase(`${'> '.repeat(31)}![a](/l.svg)`))).toEqual([]);
  });

  it('names each skip reason', async () => {
    const checkParamValue = await loadCheckParamValue();
    expect(skipOf(kase('Env {{entity}}', { entity: 'x' }), checkParamValue)).toBe('entity');
    expect(skipOf(kase('Env $v', { vars: [['v', '  ']] }), checkParamValue)).toBe('varNotUrlSafe');
    expect(skipOf(kase('Env $v', { vars: [['v', 'a'.repeat(201)]] }), checkParamValue)).toBe(
      'varNotUrlSafe',
    );
    expect(skipOf(kase('x\u0000y'), checkParamValue)).toBe('nul');
    expect(skipOf(kase('x'), checkParamValue)).toBeNull();
  });
});
