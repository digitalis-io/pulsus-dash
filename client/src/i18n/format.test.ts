import { describe, expect, it } from 'vitest';
import { T } from '../test/renderApp';
import {
  describeRange,
  formatRange,
  formatRangeShort,
  formatValue,
  formatZone,
  type Unit,
} from './format';

const TZ = 'Europe/London';
const at = (s: string): number => Date.parse(s);

describe('format', () => {
  it('formats short ranges with the zone', () => {
    expect(formatRangeShort(at('2026-11-19T12:03:00Z'), at('2026-11-19T13:03:00Z'), TZ)).toBe(
      '12:03 – 13:03 GMT',
    );
    expect(formatRangeShort(at('2026-11-18T23:00:00Z'), at('2026-11-19T01:00:00Z'), TZ)).toBe(
      '18 Nov 23:00 – 19 Nov 01:00 GMT',
    );
  });
  it('formats full ranges', () => {
    expect(formatRange(at('2026-11-19T12:03:00Z'), at('2026-11-19T13:03:00Z'), TZ)).toBe(
      '19 Nov 2026, 12:03:00 – 13:03:00',
    );
    expect(formatRange(at('2026-11-18T23:00:00Z'), at('2026-11-19T01:00:00Z'), TZ)).toBe(
      '18 Nov 2026, 23:00:00 – 19 Nov 2026, 01:00:00',
    );
  });
  it('describes quick, absolute and other ranges', () => {
    expect(describeRange({ from: 'now-6h', to: 'now', refresh: 'off' }, T, TZ)).toBe(
      'Last 6 hours',
    );
    expect(describeRange({ from: 'now-90m', to: 'now', refresh: 'off' }, T, TZ)).toBe(
      'now-90m to now',
    );
    expect(
      describeRange(
        { from: '2026-11-19T12:03:00.000Z', to: '2026-11-19T13:03:00.000Z', refresh: 'off' },
        T,
        TZ,
      ),
    ).toBe('19 Nov 2026, 12:03:00 – 13:03:00');
  });
  it('names the zone with its offset', () => {
    expect(formatZone(TZ, T)).toBe('Europe/London (GMT)');
  });
});

const NONE: Unit = { kind: 'none' };
const MS: Unit = { kind: 'time', base: 'ms' };
const S: Unit = { kind: 'time', base: 's' };
const BYTES: Unit = { kind: 'bytes' };

describe('unit:number-format', () => {
  it.each<[number, Unit, string]>([
    [2843, MS, '2.84 s'],
    [1204, { kind: 'suffix', suffix: 'rps' }, '1.2k rps'],
    [38, { kind: 'percent' }, '38 %'],
    [0.38, { kind: 'percentunit' }, '38 %'],
    [1610612736, BYTES, '1.5 GiB'],
    [0, NONE, '0'],
    [NaN, NONE, '—'],
    [Infinity, NONE, '+Inf'],
    [-Infinity, NONE, '-Inf'],
    [999.6, MS, '1 s'],
    [59.99, S, '1 min'],
    [-1204, NONE, '-1.2k'],
    [0.0123, NONE, '0.0123'],
    [1e15, NONE, '1P'],
    [120, MS, '120 ms'],
    [1.5e-7, S, '150 ns'],
    [512, BYTES, '512 B'],
    [1023, BYTES, '1023 B'],
    [1024, BYTES, '1 KiB'],
    [1048575, BYTES, '1 MiB'],
    [0, MS, '0 s'],
  ])('formatValue(%s, %o) = %s', (v, unit, want) => {
    expect(formatValue(v, unit)).toBe(want);
  });
});
