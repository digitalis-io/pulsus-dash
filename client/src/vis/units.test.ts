import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Unit } from '../i18n/format';
import { panelUnits, rated, UNIT_CATALOGUE, UNIT_IDS, unitOf, type UnitId } from './units';

/** `api/fixtures/board-spec/unit-ids.json` (vitest runs in `client/`). */
const IDS = JSON.parse(
  readFileSync(join(process.cwd(), '..', 'api', 'fixtures', 'board-spec', 'unit-ids.json'), 'utf8'),
) as string[];

const NONE: Unit = { kind: 'none' };
const PER_S: Unit = { kind: 'suffix', suffix: '/s' };

// unit:unit-catalogue (#290 §3.2; T22-016).
describe('unit:unit-catalogue', () => {
  it('the ids equal unit-ids.json, in catalogue order', () => {
    expect([...UNIT_IDS]).toEqual(IDS);
    expect(UNIT_CATALOGUE.map((e) => e.id)).toEqual(IDS);
    expect(UNIT_CATALOGUE.map((e) => e.group)).toEqual([
      ...(['general', 'general', 'general'] as const),
      ...(['time', 'time', 'time', 'time'] as const),
      ...(['data', 'data', 'data', 'data'] as const),
      ...(['rate', 'rate', 'rate', 'rate', 'rate', 'rate'] as const),
      ...(['percent', 'percent'] as const),
    ]);
    for (const e of UNIT_CATALOGUE) {
      expect(e.label).toBe(`unit.id.${e.id}`);
      expect(e.example === null, e.id).toBe(e.id === 'custom');
      expect(e.unit === null, e.id).toBe(e.id === 'custom');
      if (e.unit !== null) expect(e.unit, e.id).toEqual(unitOf({ id: e.id }));
    }
  });

  it.each<[UnitId, Unit]>([
    ['count', NONE],
    ['none', { kind: 'plain' }],
    ['seconds', { kind: 'time', base: 's' }],
    ['milliseconds', { kind: 'time', base: 'ms' }],
    ['microseconds', { kind: 'time', base: 'us' }],
    ['nanoseconds', { kind: 'time', base: 'ns' }],
    ['bytes', { kind: 'bytes' }],
    ['bytesSI', { kind: 'bytes', prefix: 'si' }],
    ['bits', { kind: 'bits', prefix: 'si' }],
    ['bitsIEC', { kind: 'bits', prefix: 'iec' }],
    ['perSecond', PER_S],
    ['reqPerSecond', { kind: 'suffix', suffix: 'req/s' }],
    ['bytesPerSecond', { kind: 'bytes', perSecond: true }],
    ['bytesSIPerSecond', { kind: 'bytes', prefix: 'si', perSecond: true }],
    ['bitsPerSecond', { kind: 'bits', prefix: 'si', perSecond: true }],
    ['bitsIECPerSecond', { kind: 'bits', prefix: 'iec', perSecond: true }],
    ['percent', { kind: 'percent' }],
    ['percentUnit', { kind: 'percentunit' }],
  ])('unitOf(%s)', (id, want) => {
    expect(unitOf({ id })).toEqual(want);
  });

  it('unitOf(custom) is its suffix', () => {
    expect(unitOf({ id: 'custom', suffix: 'rps' })).toEqual({ kind: 'suffix', suffix: 'rps' });
  });
});

// T22-017: a rate rewrite makes data and count units per second, never time or percent.
describe('rate promotion', () => {
  it.each<[Unit, Unit]>([
    [NONE, PER_S],
    [
      { kind: 'suffix', suffix: 'req' },
      { kind: 'suffix', suffix: 'req/s' },
    ],
    [
      { kind: 'suffix', suffix: 'req/s' },
      { kind: 'suffix', suffix: 'req/s' },
    ],
    [{ kind: 'bytes' }, { kind: 'bytes', perSecond: true }],
    [
      { kind: 'bytes', prefix: 'si' },
      { kind: 'bytes', prefix: 'si', perSecond: true },
    ],
    [
      { kind: 'bits', prefix: 'iec' },
      { kind: 'bits', prefix: 'iec', perSecond: true },
    ],
    [
      { kind: 'bytes', perSecond: true },
      { kind: 'bytes', perSecond: true },
    ],
    [
      { kind: 'time', base: 's' },
      { kind: 'time', base: 's' },
    ],
    [{ kind: 'percent' }, { kind: 'percent' }],
    [{ kind: 'percentunit' }, { kind: 'percentunit' }],
    [{ kind: 'plain' }, { kind: 'plain' }],
  ])('rated(%o) = %o', (u, want) => {
    expect(rated(u)).toEqual(want);
  });
});

// T22-015: one stored unit per panel, resolved on the drawn kind.
describe('panelUnits', () => {
  it('absent: none, or /s after a rate rewrite', () => {
    expect(panelUnits(undefined, 'line', false)).toEqual({ value: NONE, count: NONE });
    expect(panelUnits({}, 'line', true)).toEqual({ value: PER_S, count: PER_S });
    expect(panelUnits({}, 'heatmap', true)).toEqual({ value: NONE, count: PER_S });
    expect(panelUnits(undefined, 'stat', true)).toEqual({ value: PER_S, count: PER_S });
  });

  it('set: the unit, rated on every kind but the heatmap', () => {
    const bytes = { unit: { id: 'bytes' } };
    expect(panelUnits(bytes, 'line', false)).toEqual({ value: { kind: 'bytes' }, count: NONE });
    expect(panelUnits(bytes, 'line', true)).toEqual({
      value: { kind: 'bytes', perSecond: true },
      count: PER_S,
    });
    expect(panelUnits(bytes, 'heatmap', true)).toEqual({ value: { kind: 'bytes' }, count: PER_S });
    expect(panelUnits(bytes, 'heatmap', false)).toEqual({ value: { kind: 'bytes' }, count: NONE });
    expect(panelUnits({ unit: { id: 'seconds' } }, 'stat', true)).toEqual({
      value: { kind: 'time', base: 's' },
      count: PER_S,
    });
    expect(panelUnits({ unit: { id: 'percentUnit' } }, 'barchart', false).value).toEqual({
      kind: 'percentunit',
    });
    expect(panelUnits({ unit: { id: 'custom', suffix: 'rps' } }, 'geomap', true).value).toEqual({
      kind: 'suffix',
      suffix: 'rps/s',
    });
  });
});
