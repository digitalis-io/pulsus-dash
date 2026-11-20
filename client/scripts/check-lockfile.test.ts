import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkLockfileDir } from './check-lockfile.ts';

const dir = (name: string): string =>
  fileURLToPath(new URL(`./__fixtures__/lockfile/${name}`, import.meta.url));
const ids = (name: string): string[] =>
  checkLockfileDir(dir(name)).map((f) => `${f.rule} ${f.subject ?? ''}`);

describe('lockfile fixtures (T05-002)', () => {
  it('ok → none', () => {
    expect(ids('ok')).toEqual([]);
  });
  it('a caret range → non-exact-version', () => {
    expect(ids('caret')).toEqual(['non-exact-version react']);
  });
  it('a foreign registry → non-registry-resolved', () => {
    expect(ids('foreign')).toEqual(['non-registry-resolved node_modules/react']);
  });
  it('no integrity → missing-integrity', () => {
    expect(ids('no-integrity')).toEqual(['missing-integrity node_modules/react']);
  });
  it('lockfile v2 → lockfile-version', () => {
    expect(ids('v2')).toEqual(['lockfile-version 2']);
  });
  it('the real lockfile passes', () => {
    expect(checkLockfileDir(fileURLToPath(new URL('..', import.meta.url)))).toEqual([]);
  });
});
