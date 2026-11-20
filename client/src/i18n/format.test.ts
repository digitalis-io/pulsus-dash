import { describe, expect, it } from 'vitest';
import { T } from '../test/renderApp';
import { describeRange, formatRange, formatRangeShort, formatZone } from './format';

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
