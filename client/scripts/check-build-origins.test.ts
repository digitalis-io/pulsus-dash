import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkOrigins } from './check-build-origins.ts';
import { parsePolicy } from './check-deps.ts';
import { isError } from './lib/report.ts';

const clientRoot = fileURLToPath(new URL('..', import.meta.url));
const policy = parsePolicy(JSON.parse(readFileSync(`${clientRoot}dependency-policy.json`, 'utf8')));
const fixtures = fileURLToPath(new URL('./__fixtures__/origins/', import.meta.url));

function lines(dist: string, rule: string, file: string): number[] {
  const ls = checkOrigins(dist, policy.buildUrlAllowlist, false)
    .filter((f) => isError(f) && f.rule === rule && f.file === file)
    .map((f) => f.line ?? 0);
  return [...new Set(ls)].sort((a, b) => a - b);
}

describe('build origins: resource positions (T05-002)', () => {
  it('fails every URL in a resource position, whatever its origin', () => {
    const bad = `${fixtures}bad`;
    expect(lines(bad, 'third-party-resource', 'assets/a.js')).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(lines(bad, 'third-party-resource', 'assets/b.css')).toEqual([1, 2, 3]);
    expect(lines(bad, 'third-party-resource', 'index.html')).toEqual([1, 2, 3, 4]);
  });
});

describe('build origins: text and indirection (T05-002)', () => {
  it('allows only exact allowlisted tokens in JS text, none in CSS', () => {
    const bad = `${fixtures}bad`;
    expect(lines(bad, 'third-party-host', 'assets/i.js')).toEqual([1, 4, 5]);
    expect(lines(bad, 'third-party-host', 'assets/t.css')).toEqual([1]);
    expect(lines(bad, 'computed-url', 'assets/i.js')).toEqual([2, 3]);
  });
  it('good → none', () => {
    expect(checkOrigins(`${fixtures}good`, policy.buildUrlAllowlist, false)).toEqual([]);
  });
});

describe('build origins: sink resolution (T05-002)', () => {
  it('resolves const bindings, concatenation and templates at sinks', () => {
    expect(lines(`${fixtures}bad`, 'third-party-resource', 'assets/r.js')).toEqual([1, 2, 3, 4, 5]);
    expect(lines(`${fixtures}good`, 'third-party-resource', 'assets/r.js')).toEqual([]);
  });
});

describe('build origins real build', () => {
  const dist = `${clientRoot}dist`;
  it.skipIf(!existsSync(dist))(
    'the production build has no errors (CI runs npm run origins)',
    () => {
      expect(checkOrigins(dist, policy.buildUrlAllowlist).filter(isError)).toEqual([]);
    },
  );
});
