/** Panel options (board spec v3; plan #173 Part 1 §3.6, `unit:board-options`). */
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PanelVisKind } from '../api/types';
import {
  barchartOptions,
  keepOptions,
  OPTION_KEYS,
  OPTION_MEMBERS,
  OPTION_ORDER,
  OPTION_TYPES,
  PENDING_KINDS,
  withKind,
} from './options';

const FIXTURE = join(process.cwd(), '..', 'api', 'fixtures', 'board-spec', 'option-keys.json');

describe('unit:board-options', () => {
  it('a kind change keeps only the keys the new kind allows', () => {
    const line = withKind(
      {
        kind: 'barchart',
        thresholds: { direction: 'above', steps: [{ value: 1, state: 'watch', label: '' }] },
        options: { reducer: 'sum', categoryBy: 'version', valueLabels: false },
      },
      'line',
    );
    expect(line).toEqual({
      kind: 'line',
      thresholds: { direction: 'above', steps: [{ value: 1, state: 'watch', label: '' }] },
    });
    expect('options' in line).toBe(false);
    expect(
      withKind({ kind: 'stat', options: { reducer: 'max', layout: 'grid' } }, 'barchart'),
    ).toEqual({
      kind: 'barchart',
      options: { reducer: 'max' },
    });
    expect(keepOptions('line', { reducer: 'max' })).toBeUndefined();
    expect(keepOptions('auto', undefined)).toBeUndefined();
  });

  it('barchart defaults', () => {
    expect(barchartOptions(undefined)).toEqual({
      reducer: 'last',
      baselineOffset: null,
      categoryBy: '',
      sort: 'valueDesc',
      orientation: 'horizontal',
      valueLabels: true,
      min: undefined,
      max: undefined,
    });
    // The board list's sorts are not a chart's (board spec v6): the default.
    expect(barchartOptions({ sort: 'incidents' }).sort).toBe('valueDesc');
    expect(barchartOptions({ sort: 'default' }).sort).toBe('valueDesc');
    expect(barchartOptions({ sort: 'label', min: 0, baselineOffset: '7d' })).toMatchObject({
      sort: 'label',
      min: 0,
      baselineOffset: '7d',
      reducer: 'last',
    });
  });

  it('the key tables equal option-keys.json', () => {
    const f = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
      types: Record<string, string>;
      members: Record<string, string[]>;
      kinds: Record<string, string[]>;
    };
    expect(OPTION_ORDER).toEqual(Object.keys(f.types));
    expect(OPTION_TYPES).toEqual(f.types);
    expect(OPTION_MEMBERS).toEqual(f.members);
    expect(OPTION_KEYS).toEqual(f.kinds);
    // Every kind's keys are in OPTION_ORDER order.
    for (const [kind, keys] of Object.entries(OPTION_KEYS))
      expect(keys, kind).toEqual(OPTION_ORDER.filter((k) => keys.includes(k)));
    expect([...PENDING_KINDS].sort()).toEqual(['barchart', 'pie'] satisfies PanelVisKind[]);
  });
});
