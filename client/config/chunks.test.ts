/**
 * unit:initial-chunk-group (plan #263 §5): the `$initial` code-splitting group keeps the static
 * closure of `index.html` in one chunk, without the `geo-assets` entry, and `vite.config.ts` uses it.
 */
import { describe, expect, it } from 'vitest';
import { clientConfig } from '../vite.config.ts';
import { absentEngine } from './dashEngine.ts';
import { INITIAL_GROUP } from './chunks.ts';

const test = (id: string): boolean => {
  const t = INITIAL_GROUP.test;
  return typeof t === 'function' && t(id) === true;
};

describe('unit:initial-chunk-group', () => {
  it('(a) tags $initial; never the geo-assets entry', () => {
    expect(INITIAL_GROUP.tags).toEqual(['$initial']);
    expect(typeof INITIAL_GROUP.test).toBe('function');
    expect(test('/r/client/src/vis/geo/urls.ts')).toBe(false);
    expect(test('C:\\r\\client\\src\\vis\\geo\\urls.ts')).toBe(false);
  });

  it('(b) every other module of the initial closure', () => {
    expect(test('/r/client/src/kit/Icon.tsx')).toBe(true);
    expect(test('/r/client/src/vis/geo/projection.ts')).toBe(true);
    expect(test('/r/node_modules/react-aria/x.mjs')).toBe(true);
  });

  it('(c) vite.config.ts splits code with exactly this group', () => {
    const output = clientConfig(absentEngine).build?.rolldownOptions?.output;
    const one = Array.isArray(output) ? undefined : output;
    const split = one?.codeSplitting;
    expect(typeof split === 'object' ? split.groups : undefined).toEqual([INITIAL_GROUP]);
  });
});
