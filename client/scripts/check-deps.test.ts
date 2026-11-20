import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkDepsDir, parsePolicy } from './check-deps.ts';

const dir = (name: string): string =>
  fileURLToPath(new URL(`./__fixtures__/deps/${name}`, import.meta.url));
const ids = (name: string): string[] =>
  checkDepsDir(dir(name)).map((f) => `${f.rule} ${f.subject ?? ''}`);
const clientRoot = fileURLToPath(new URL('..', import.meta.url));

describe('dep-audit fixtures (T05-002)', () => {
  it('ok → none', () => {
    expect(ids('ok')).toEqual([]);
  });
  it('a dependency off the allowlist', () => {
    expect(ids('not-allowlisted')).toEqual(['not-allowlisted pkg-a']);
  });
  it('a runtime package missing from the closure lists', () => {
    expect(ids('not-in-closure')).toEqual(['not-in-closure pkg-b']);
  });
  it('a listed package that is not installed', () => {
    expect(ids('stale')).toEqual(['stale-closure pkg-c']);
  });
  it('a forbidden category', () => {
    expect(ids('forbidden')).toEqual(['forbidden-category charting']);
  });
  it.each(['gpl', 'busl', 'unlicense', 'exception'])('licence not allowed: %s', (name) => {
    expect(ids(name)).toEqual(['licence pkg-helper']);
  });
  it('a GPL package that is dev-only is not a runtime package', () => {
    expect(ids('dev-gpl')).toEqual([]);
  });
});

describe('dep-audit real tree', () => {
  it('passes with ADR-0014 §7 licence list unchanged', () => {
    expect(checkDepsDir(clientRoot)).toEqual([]);
    const policy = parsePolicy(
      JSON.parse(readFileSync(`${clientRoot}dependency-policy.json`, 'utf8')),
    );
    expect(policy.licenceAllowlist).toEqual([
      'MIT',
      'ISC',
      'BSD-2-Clause',
      'BSD-3-Clause',
      'Apache-2.0',
      '0BSD',
      'MPL-2.0',
    ]);
    expect(policy.licenceExceptionAllowlist).toEqual([]);
  });
});
