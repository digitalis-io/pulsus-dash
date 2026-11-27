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
import { HTTP_BFF } from '../e2e/bff.ts';
import {
  compareBaseline,
  isBrowserCspReport,
  isExempt,
  isPermittedImage,
  readBaseline,
  requestKey,
} from '../e2e/loadWatch.ts';
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

describe('loadWatch: the CSP report exemption', () => {
  const u = (p: string) => new URL(p, 'http://localhost:4174');
  const reports = JSON.stringify([
    { type: 'csp-violation', body: { effectiveDirective: 'img-src' } },
  ]);
  const legacy = JSON.stringify({ 'csp-report': { 'violated-directive': 'img-src' } });
  it('exempts only a same-origin browser report to the exact path', () => {
    const path = '/api/dash/v1/csp-report';
    expect(isBrowserCspReport('POST', u(path), 'application/reports+json', reports)).toBe(true);
    expect(isBrowserCspReport('POST', u(path), 'application/csp-report', legacy)).toBe(true);
    const one = JSON.stringify({ type: 'csp-violation', body: { effectiveDirective: 'img-src' } });
    expect(isBrowserCspReport('POST', u(path), 'application/csp-report', one)).toBe(true);
    expect(isBrowserCspReport('POST', u(path), 'application/csp-report', '{"leak":1}')).toBe(false);
    expect(isBrowserCspReport('POST', u(`${path}?x=1`), 'application/reports+json', reports)).toBe(
      false,
    );
    expect(isBrowserCspReport('POST', u(path), 'application/json', reports)).toBe(false);
    expect(isBrowserCspReport('POST', u(path), 'application/reports+json', '{"a":1}')).toBe(false);
    expect(isBrowserCspReport('POST', u(path), 'application/reports+json', '[]')).toBe(false);
    expect(isBrowserCspReport('POST', u(path), 'application/reports+json', 'x')).toBe(false);
    expect(isBrowserCspReport('GET', u(path), 'application/reports+json', reports)).toBe(false);
    expect(isBrowserCspReport('POST', u(`${path}/x`), 'application/reports+json', reports)).toBe(
      false,
    );
    expect(
      isBrowserCspReport(
        'POST',
        new URL(path, 'http://evil.test'),
        'application/reports+json',
        reports,
      ),
    ).toBe(false);
  });
});

describe('unit:load-baseline-keys (#263)', () => {
  const foreign = (path: string): URL => {
    const u = new URL(path, HTTP_BFF);
    u.port = '4175';
    return u;
  };
  const same = (path: string): URL => new URL(path, HTTP_BFF);

  it('(a) the key of a foreign request carries its origin; a same-origin key does not', () => {
    const u = foreign('/assets/x-AbCdEfGh.js');
    expect(requestKey('GET', 'script', u)).toBe(`GET script ${u.origin}/assets/x-{hash}.js`);
    expect(requestKey('GET', 'script', same('/assets/x-AbCdEfGh.js'))).toBe(
      'GET script /assets/x-{hash}.js',
    );
  });

  it('(b) every committed key is a same-origin path; every asset key names a chunk', () => {
    for (const project of ['chromium', 'firefox', 'webkit']) {
      const keys = Object.keys(readBaseline(project));
      expect(keys.length, project).toBeGreaterThan(0);
      for (const k of keys) {
        expect(k, `${project}: ${k}`).toMatch(/^(GET|PUT|POST) [a-z]+ \//);
        if (/^[A-Z]+ [a-z]+ \/assets\//.test(k))
          expect(k, `${project}: ${k}`).toContain('-{hash}.');
      }
    }
  });

  it('(c) the favicon exemption is same-origin only', () => {
    expect(isExempt('GET', foreign('/favicon.ico'))).toBe(false);
    expect(isExempt('GET', same('/favicon.ico'))).toBe(true);
  });

  it('(d) a permitted image is same-origin only', () => {
    const images = new Set(['/a.svg']);
    expect(isPermittedImage('image', foreign('/a.svg'), images)).toBe(false);
    expect(isPermittedImage('image', same('/a.svg'), images)).toBe(true);
  });
});
