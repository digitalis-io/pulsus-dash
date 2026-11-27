/** unit:resolve-variables (SRF-017, plan #289 §4.2). */
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BoardSpec, BoardVariable } from '../api/types';
import {
  resolveVariables,
  selectionBytes,
  sortValues,
  type VariableList,
  type VarState,
} from './resolveVariables';

const CLICKHOUSE = JSON.parse(
  readFileSync(
    join(process.cwd(), '..', 'api', 'fixtures', 'board-spec', 'v9-variables.json'),
    'utf8',
  ),
) as BoardSpec;
const DEFS = CLICKHOUSE.variables ?? [];
const NODE = DEFS[0] as BoardVariable;

const ready = (values: readonly string[], truncated = false): VariableList => ({
  status: 'ready',
  values,
  truncated,
});
const LOADING: VariableList = { status: 'loading' };
const FAILED: VariableList = { status: 'failed', error: new Error('x') };

function one(
  def: BoardVariable,
  address: readonly string[] | undefined,
  list: VariableList | undefined,
): VarState | undefined {
  const a = new Map<string, readonly string[]>(address === undefined ? [] : [[def.name, address]]);
  const l = new Map<string, VariableList>(list === undefined ? [] : [[def.name, list]]);
  return resolveVariables([def], a, l).get(def.name);
}

const valueOf = (s: VarState | undefined) => (s?.kind === 'ready' ? s.value : s?.kind);

describe('unit:resolve-variables', () => {
  it('the ClickHouse board without an address is All (.+)', () => {
    const states = resolveVariables(DEFS, new Map(), new Map([['node', ready(['n1', 'n2'])]]));
    expect(states.get('node')).toEqual({
      kind: 'ready',
      value: { all: '.+' },
      display: 'All',
      selection: { all: true },
    });
    // The custom env takes its first sorted value (sort none: as written); the constant its value.
    expect(valueOf(states.get('env'))).toEqual({ values: ['prod'] });
    expect(valueOf(states.get('dc'))).toEqual({ values: ['eu-west-1'] });
  });

  it('includeAll without allValue is .*, with the list truncated or loading too', () => {
    const def: BoardVariable = { ...NODE };
    delete def.allValue;
    for (const list of [ready(['a'], true), LOADING, ready(['a'])]) {
      expect(valueOf(one(def, undefined, list))).toEqual({ all: '.*' });
    }
  });

  it('the address over the default', () => {
    expect(valueOf(one(NODE, ['n2'], ready(['n1', 'n2'])))).toEqual({ values: ['n2'] });
    const s = one(NODE, ['n2', 'n3'], ready(['n1']));
    expect(s).toEqual({
      kind: 'ready',
      value: { values: ['n2', 'n3'] },
      display: 'n2 +1',
      selection: { values: ['n2', 'n3'] },
    });
  });

  it('a single-select variable takes the first address value', () => {
    const env = DEFS[1] as BoardVariable;
    expect(valueOf(one(env, ['a', 'b'], undefined))).toEqual({ values: ['a'] });
  });

  it('a constant ignores the address', () => {
    const dc = DEFS[2] as BoardVariable;
    expect(valueOf(one(dc, ['x'], undefined))).toEqual({ values: ['eu-west-1'] });
  });

  it('an empty list without an address or default is unset', () => {
    const def: BoardVariable = { ...NODE };
    delete def.default;
    expect(one(def, undefined, ready([]))).toEqual({ kind: 'unset' });
    expect(one(def, undefined, LOADING)).toEqual({ kind: 'loading' });
    expect(valueOf(one(def, undefined, ready(['b', 'a'])))).toEqual({ values: ['a'] });
  });

  it('a failed list: ready from the address, failed without one or a default', () => {
    expect(valueOf(one(NODE, ['n1'], FAILED))).toEqual({ values: ['n1'] });
    const def: BoardVariable = { ...NODE };
    delete def.default;
    expect(one(def, undefined, FAILED)?.kind).toBe('failed');
  });

  it('a dependent of an unset, failed or too-large variable waits', () => {
    const a: BoardVariable = { ...NODE, name: 'a', label: 'A' };
    delete a.default;
    const b: BoardVariable = {
      ...NODE,
      name: 'b',
      label: 'B',
      query: { lang: 'promql', text: 'label_values(up{a=~"$a"}, b)' },
    };
    for (const list of [ready([]), FAILED]) {
      const s = resolveVariables([a, b], new Map(), new Map([['a', list]]));
      expect(s.get('b')).toEqual({ kind: 'waiting', on: 'a' });
    }
    const loading = resolveVariables([a, b], new Map(), new Map([['a', LOADING]]));
    expect(loading.get('b')).toEqual({ kind: 'loading' });
    const many = Array.from({ length: 201 }, (_, i) => `v${String(i)}`);
    const tooMany = resolveVariables([a, b], new Map([['a', many]]), new Map());
    expect(tooMany.get('a')?.kind).toBe('tooMany');
    expect(tooMany.get('b')).toEqual({ kind: 'waiting', on: 'a' });
  });

  it('sorts: numbers by value, the rest last in code-unit order', () => {
    expect(sortValues(['10', '9', 'x'], 'numAsc')).toEqual(['9', '10', 'x']);
    expect(sortValues(['10', '9', 'x', 'b'], 'numDesc')).toEqual(['10', '9', 'b', 'x']);
    expect(sortValues(['b', 'B', 'a'], 'alphaAsc')).toEqual(['B', 'a', 'b']);
    expect(sortValues(['b', 'B', 'a'], 'alphaDesc')).toEqual(['b', 'a', 'B']);
    expect(sortValues(['b', 'a'], 'none')).toEqual(['b', 'a']);
  });

  it('a listed $__all is the literal, not All', () => {
    const def: BoardVariable = { ...NODE };
    delete def.default;
    expect(valueOf(one(def, undefined, ready(['$__all', 'b'])))).toEqual({ values: ['$__all'] });
    expect(valueOf(one(NODE, ['$$__all'], ready([])))).toEqual({ values: ['$__all'] });
    expect(valueOf(one(NODE, ['$__all'], ready([])))).toEqual({ all: '.+' });
  });

  it('200 values are ready, 201 too many', () => {
    const vs = Array.from({ length: 201 }, (_, i) => `v${String(i)}`);
    expect(one(NODE, vs.slice(0, 200), ready([]))?.kind).toBe('ready');
    expect(one(NODE, vs, ready([]))?.kind).toBe('tooMany');
  });

  it('65 536 selection bytes are ready, 65 537 too many', () => {
    const es = Array.from(
      { length: 200 },
      (_, i) => '\u{1F600}'.repeat(80) + String(i).padStart(3, '0'),
    );
    let n = selectionBytes(es);
    for (let i = 0; n < 65_536; i++, n++) es[i % 200] = `${es[i % 200] ?? ''}z`;
    expect(selectionBytes(es)).toBe(65_536);
    expect(one(NODE, es, ready([]))?.kind).toBe('ready');
    es[0] = `${es[0] ?? ''}z`;
    expect(selectionBytes(es)).toBe(65_537);
    expect(one(NODE, es, ready([]))?.kind).toBe('tooMany');
    expect(selectionBytes(['é'])).toBe(6);
  });

  it('an undefined name is its first raw address value, else unset', () => {
    const s = resolveVariables([], new Map([['x', ['$a', 'b']]]), new Map(), ['x', 'y']);
    expect(s.get('x')).toEqual({
      kind: 'ready',
      value: '$a',
      display: '$a',
      selection: { values: ['$a'] },
    });
    expect(s.get('y')).toEqual({ kind: 'unset' });
  });
});
