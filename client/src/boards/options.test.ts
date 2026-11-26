/** Panel options (board spec v3; plan #173 Part 1 §3.6, `unit:board-options`). */
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkBoardSpec } from './spec';
import type { PanelVisKind, VisOptions } from '../api/types';
import {
  barchartOptions,
  keepOptions,
  optionValueValid,
  OPTION_KEYS,
  OPTION_MEMBERS,
  OPTION_ORDER,
  OPTION_TYPES,
  PENDING_KINDS,
  withKind,
} from './options';

const FIXTURE = join(process.cwd(), '..', 'api', 'fixtures', 'board-spec', 'option-keys.json');
const INVALID = join(process.cwd(), '..', 'api', 'fixtures', 'board-spec', 'invalid.json');

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

describe('unit:board-options (values)', () => {
  it('a kind change keeps only valid values', () => {
    expect(
      keepOptions('barchart', { orientation: 'auto', reducer: 'max', layout: 'grid' }),
    ).toEqual({ reducer: 'max' });
    expect(keepOptions('stat', { orientation: 'vertical', min: 5, max: 500 })).toEqual({
      orientation: 'vertical',
      min: 5,
      max: 500,
    });
    expect(keepOptions('barchart', { min: 5, max: 5 })).toEqual({ min: 5 });
    expect(keepOptions('stat', { layout: 'grid', textMode: 'value' })).toEqual({ layout: 'grid' });
    expect(keepOptions('barchart', { categoryBy: 'bad key', sort: 'label' })).toEqual({
      sort: 'label',
    });
    expect(keepOptions('barchart', { orientation: 'auto' })).toBeUndefined();
  });

  // Rules that compare two keys: the per-key check cannot see them (keepOptions applies them).
  const CROSS_KEY = new Set([
    'options-min-eq-max',
    'options-stat-text-grid',
    'w-text-language-md',
    'bl-recent-query',
    'bl-starred-tag',
  ]);

  it('optionValueValid is false exactly where the validator reports a value', () => {
    type Panel = { vis?: { kind?: unknown; options?: unknown } } | null;
    const cases = JSON.parse(readFileSync(INVALID, 'utf8')) as {
      name: string;
      spec: { panels?: Panel[]; sections?: { panels?: Panel[] }[] } | null;
    }[];
    const list = (x: unknown): Panel[] => (Array.isArray(x) ? (x as Panel[]) : []);
    let checked = 0;
    for (const c of cases) {
      if (CROSS_KEY.has(c.name) || c.spec === null || typeof c.spec !== 'object') continue;
      const sections = Array.isArray(c.spec.sections) ? c.spec.sections : [];
      const panels = [
        ...list(c.spec.panels).map((p, i) => ({ p, at: `/panels/${String(i)}` })),
        ...sections.flatMap((s, j) =>
          list(s.panels).map((p, i) => ({ p, at: `/sections/${String(j)}/panels/${String(i)}` })),
        ),
      ];
      const fields = checkBoardSpec(c.spec);
      for (const { p, at } of panels) {
        const o = p?.vis?.options;
        const kind = p?.vis?.kind;
        if (typeof kind !== 'string' || !(kind in OPTION_KEYS)) continue;
        if (o === null || typeof o !== 'object' || Array.isArray(o)) continue;
        for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
          const allowed: readonly string[] = OPTION_KEYS[kind as PanelVisKind];
          if (!allowed.includes(k)) continue;
          const ptr = `${at}/vis/options/${k}`;
          const reported = fields.some((f) => f.pointer === ptr || f.pointer.startsWith(`${ptr}/`));
          expect(
            optionValueValid(kind as PanelVisKind, k as keyof VisOptions, v),
            `${c.name} ${k}`,
          ).toBe(!reported);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(20);
  });
});
