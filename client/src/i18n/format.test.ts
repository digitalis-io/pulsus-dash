import { describe, expect, it } from 'vitest';
import { holdLabels, minValueBand } from '../engine/canvas2d/draw';
import { mulberry32 } from '../test/random';
import { recordingContext } from '../test/recordingContext';
import { T } from '../test/renderApp';
import {
  compactSamples,
  describeRange,
  formatCompact,
  formatRange,
  formatLogTime,
  formatRangeShort,
  formatValue,
  formatZone,
  tickBase,
  unitLabel,
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

  // T21-013: a converted value c ≥ 1e21 or 0 < c < 1e−12 takes the exponent form plus the base tail.
  it.each<[number, Unit, string]>([
    [1e21, NONE, '1e+21'],
    [2.5e22, NONE, '2.5e+22'],
    [1e-4, { kind: 'time', base: 'ns' }, '1e-13 s'],
    [1e22, BYTES, '1e+22 B'],
    [5e21, { kind: 'suffix', suffix: 'rps' }, '5e+21 rps'],
    [1e19, { kind: 'percentunit' }, '1e+21 %'],
    [1e-13, NONE, '1e-13'],
  ])('out-of-range form: formatValue(%s, %o) = %s', (v, unit, want) => {
    expect(formatValue(v, unit)).toBe(want);
  });

  it.each<[number, number, string]>([
    [6.999999999999999, 3, '7'],
    [6.999999999999999, 17, '6.9999999999999991'],
    [1 + 2 ** -52, 17, '1.0000000000000002'],
    [1234, 4, '1.234k'],
    [123.456, 5, '123.46'],
  ])('digits: formatValue(%s, none, %s) = %s', (v, digits, want) => {
    expect(formatValue(v, NONE, digits)).toBe(want);
  });
});

describe('formatCompact examples, zero and rounding boundaries', () => {
  const NONE: Unit = { kind: 'none' };
  const RPS: Unit = { kind: 'suffix', suffix: 'rps' };
  const MS: Unit = { kind: 'time', base: 'ms' };
  it.each<[number, Unit, string]>([
    [0.000015, NONE, '15µ'],
    [-1234, NONE, '-1.23k'],
    [999_600, NONE, '1M'],
    [-0.00002, RPS, '-20µ rps'],
    [1_234_567, { kind: 'percent' }, '1.23M %'],
    [1536, { kind: 'bytes' }, '1.54k B'],
    [-3_590_000, MS, '-3.59k s'],
    [0, NONE, '0'],
    [-0, NONE, '0'],
    [0, { kind: 'percentunit' }, '0 %'],
    [0, MS, '0 s'],
    [0, { kind: 'bytes' }, '0 B'],
    [0, RPS, '0 rps'],
    [999.4, NONE, '999'],
    [999.5, NONE, '1k'],
    [-999.5, NONE, '-1k'],
    [999.96, NONE, '1k'],
    [1000, NONE, '1k'],
    [999_499, NONE, '999k'],
    [999_500, NONE, '1M'],
    [9.9996e20, NONE, '1000E'],
    [0.5, { kind: 'percentunit' }, '50 %'],
    [12.3456, { kind: 'percentunit' }, '1.23k %'],
    [999_600, MS, '1k s'],
    [NaN, NONE, '—'],
    [Infinity, NONE, '+Inf'],
  ])('formatCompact(%s, %o) = %s', (v, unit, expected) => {
    expect(formatCompact(v, unit)).toBe(expected);
  });

  it('samples: the widest compact label per prefix', () => {
    expect(compactSamples(NONE)).toEqual([
      '-88.8p',
      '-88.8n',
      '-88.8µ',
      '-88.8m',
      '-88.8',
      '-88.8k',
      '-88.8M',
      '-88.8G',
      '-88.8T',
      '-88.8P',
      '-88.8E',
    ]);
    expect(compactSamples(MS)).toContain('-88.8µ s');
  });
});

describe('formatCompact bound and fidelity', () => {
  const PREFIX: Readonly<Record<string, number>> = {
    p: -4,
    n: -3,
    µ: -2,
    m: -1,
    '': 0,
    k: 1,
    M: 2,
    G: 3,
    T: 4,
    P: 5,
    E: 6,
  };
  interface Kind {
    readonly unit: Unit;
    readonly tail: string;
    /** Converted value, and its inverse. */
    readonly c: (v: number) => number;
    readonly v: (c: number) => number;
  }
  const id = (x: number): number => x;
  const time = (base: 'ns' | 'us' | 'ms' | 's', b: number): Kind => ({
    unit: { kind: 'time', base },
    tail: ' s',
    c: (v) => v * b,
    v: (c) => c / b,
  });
  const KINDS: readonly Kind[] = [
    { unit: { kind: 'none' }, tail: '', c: id, v: id },
    { unit: { kind: 'suffix', suffix: 'rps' }, tail: ' rps', c: id, v: id },
    { unit: { kind: 'percent' }, tail: ' %', c: id, v: id },
    { unit: { kind: 'percentunit' }, tail: ' %', c: (v) => 100 * v, v: (c) => c / 100 },
    { unit: { kind: 'bytes' }, tail: ' B', c: id, v: id },
    time('ns', 1e-9),
    time('us', 1e-6),
    time('ms', 1e-3),
    time('s', 1),
  ];

  it('10 000 random values: sign, tail, length and three significant digits', () => {
    const rnd = mulberry32(93);
    let inRange = 0;
    let outside = 0;
    for (let n = 0; n < 10_000; n++) {
      const k = KINDS[Math.floor(rnd() * KINDS.length)] ?? KINDS[0];
      if (k === undefined) throw new Error('no kind');
      const sign = rnd() < 0.5 ? -1 : 1;
      const u = -22 + rnd() * 52;
      const v = sign * 10 ** u;
      const L = formatCompact(v, k.unit);
      const ctx = `${String(v)} ${JSON.stringify(k.unit)} → ${L}`;
      expect(L.startsWith('-'), ctx).toBe(v < 0);
      expect(L.endsWith(k.tail), ctx).toBe(true);
      const body = L.slice(v < 0 ? 1 : 0, L.length - k.tail.length);
      const m = /^(\d+(\.\d+)?)([pnµmkMGTPE]?)$/.exec(body);
      const cPrime = m === null ? Number(body) : Number(m[1]) * 1000 ** (PREFIX[m[3] ?? ''] ?? NaN);
      expect(Number.isFinite(cPrime), ctx).toBe(true);
      const c = Math.abs(k.c(v));
      if (c >= 1e-12 && c < 1e21) {
        inRange += 1;
        const max = Math.max(...compactSamples(k.unit).map((s) => s.length));
        expect(L.length, ctx).toBeLessThanOrEqual(max);
      } else {
        outside += 1;
      }
      const vPrime = sign * k.v(cPrime);
      expect(Math.abs(vPrime - v), ctx).toBeLessThanOrEqual((0.005 + 1e-9) * Math.abs(v));
    }
    expect(inRange).toBeGreaterThanOrEqual(1_000);
    expect(outside).toBeGreaterThanOrEqual(1_000);
  });
});

describe('out-of-range fallback and holdLabels', () => {
  it.each<[number, Unit, string]>([
    [1e-13, { kind: 'none' }, '1e-13'],
    [-1.234e-15, { kind: 'none' }, '-1.23e-15'],
    [1e21, { kind: 'none' }, '1e+21'],
    [1e22, { kind: 'none' }, '1e+22'],
    [1e-10, { kind: 'time', base: 'ms' }, '1e-13 s'],
    [1e-4, { kind: 'time', base: 'ns' }, '1e-13 s'],
    [1e19, { kind: 'percentunit' }, '1e+21 %'],
  ])('formatCompact(%s, %o) = %s', (v, unit, expected) => {
    expect(formatCompact(v, unit)).toBe(expected);
  });

  it('holdLabels keeps fitting labels, compacts wider ones, and refuses an unbounded one', () => {
    const ctx = recordingContext();
    const none: Unit = { kind: 'none' };
    const band = minValueBand(ctx, none);
    expect(band).toBe(42);
    expect(holdLabels(ctx, [1e-5, 30], none, band)).toEqual(['10µ', '30']);
    expect(holdLabels(ctx, [1.5e-13], none, band)).toBeNull();
  });
});

// unit:log-time (plan #66 Part B §3.8; T08-027).
describe('unit:log-time', () => {
  it('formats YYYY-MM-DD HH:mm:ss.SSS in the zone', () => {
    expect(formatLogTime(1767229100000, 'UTC')).toBe('2026-01-01 00:58:20.000');
    expect(formatLogTime(1767229100000, 'America/New_York')).toBe('2025-12-31 19:58:20.000');
    expect(formatLogTime(1767229100000, 'Asia/Kolkata')).toBe('2026-01-01 06:28:20.000');
    expect(formatLogTime(1767229100005, 'UTC')).toBe('2026-01-01 00:58:20.005');
  });
});

// unit:format-humans, the panel units (#290 §3.2, §3.3; T22-016, T02-011).
describe('unit:format-humans units', () => {
  const BPS: Unit = { kind: 'bytes', perSecond: true };
  const BITS_PS: Unit = { kind: 'bits', prefix: 'si', perSecond: true };
  it.each<[number, Unit, string]>([
    [1204, { kind: 'none' }, '1.2k'],
    [2026, { kind: 'plain' }, '2026'],
    [1234567, { kind: 'plain' }, '1234567'],
    [0.0123, { kind: 'plain' }, '0.0123'],
    [1204, { kind: 'suffix', suffix: 'rps' }, '1.2k rps'],
    [671000, { kind: 'time', base: 's' }, '7.77 d'],
    [2843, { kind: 'time', base: 'ms' }, '2.84 s'],
    [1500, { kind: 'time', base: 'us' }, '1.5 ms'],
    [2500, { kind: 'time', base: 'ns' }, '2.5 µs'],
    [1572864, { kind: 'bytes' }, '1.5 MiB'],
    [1500000, { kind: 'bytes', prefix: 'si' }, '1.5 MB'],
    [1.25e9, { kind: 'bits', prefix: 'si' }, '1.25 Gb'],
    [1048576, { kind: 'bits', prefix: 'iec' }, '1 Mib'],
    [12.5, { kind: 'suffix', suffix: '/s' }, '12.5 /s'],
    [1204, { kind: 'suffix', suffix: 'req/s' }, '1.2k req/s'],
    [1536, BPS, '1.5 KiB/s'],
    [1500, { kind: 'bytes', prefix: 'si', perSecond: true }, '1.5 kB/s'],
    [1.25e9, BITS_PS, '1.25 Gb/s'],
    [1048576, { kind: 'bits', prefix: 'iec', perSecond: true }, '1 Mib/s'],
    [38, { kind: 'percent' }, '38 %'],
    [0.38, { kind: 'percentunit' }, '38 %'],
    [0, BPS, '0 B/s'],
    [0.5, BPS, '0.5 B/s'],
    [-1572864, BPS, '-1.5 MiB/s'],
    [999.5, { kind: 'bytes', prefix: 'si' }, '1 kB'],
    [2.5e15, { kind: 'bytes' }, '2.22 PiB'],
    [1e22, { kind: 'bits', prefix: 'si' }, '1e+22 b'],
    [1e22, BPS, '1e+22 B/s'],
    [1e22, { kind: 'plain' }, '1e+22'],
    [NaN, { kind: 'plain' }, '—'],
  ])('formatValue(%s, %o) = %s', (v, unit, want) => {
    expect(formatValue(v, unit)).toBe(want);
  });

  it('compact: SI prefix and the unit tail', () => {
    expect(formatCompact(1536, BPS)).toBe('1.54k B/s');
    expect(formatCompact(1536, { kind: 'plain' })).toBe('1.54k');
    expect(formatCompact(1500, { kind: 'bits', prefix: 'iec' })).toBe('1.5k b');
    expect(compactSamples(BITS_PS)[4]).toBe('-88.8 b/s');
    expect(compactSamples({ kind: 'bytes', prefix: 'si' })[4]).toBe('-88.8 B');
  });

  it('tickBase and unitLabel', () => {
    const units: [Unit, 1000 | 1024, string | null][] = [
      [{ kind: 'none' }, 1000, null],
      [{ kind: 'plain' }, 1000, null],
      [{ kind: 'suffix', suffix: 'rps' }, 1000, 'rps'],
      [{ kind: 'time', base: 's' }, 1000, 's'],
      [{ kind: 'time', base: 'us' }, 1000, 'µs'],
      [{ kind: 'bytes' }, 1024, 'B'],
      [{ kind: 'bytes', prefix: 'iec' }, 1024, 'B'],
      [{ kind: 'bytes', prefix: 'si' }, 1000, 'B'],
      [BPS, 1024, 'B/s'],
      [{ kind: 'bytes', prefix: 'si', perSecond: true }, 1000, 'B/s'],
      [{ kind: 'bits', prefix: 'si' }, 1000, 'b'],
      [{ kind: 'bits', prefix: 'iec' }, 1024, 'b'],
      [BITS_PS, 1000, 'b/s'],
      [{ kind: 'bits', prefix: 'iec', perSecond: true }, 1024, 'b/s'],
      [{ kind: 'percent' }, 1000, '%'],
      [{ kind: 'percentunit' }, 1000, '%'],
    ];
    for (const [u, base, label] of units) {
      expect(tickBase(u), JSON.stringify(u)).toBe(base);
      expect(unitLabel(u), JSON.stringify(u)).toBe(label);
    }
  });
});
