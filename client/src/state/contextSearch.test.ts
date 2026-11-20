import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../test/random';
import { T } from '../test/renderApp';
import {
  DEFAULT_CONTEXT,
  normalisedSearch,
  readContextSearch,
  writeContextSearch,
  REFRESH_INTERVALS,
  type ContextSearch,
} from './contextSearch';

const env = { nowMs: T, timeZone: 'Europe/London' };
const read = (s: string) => readContextSearch(new URLSearchParams(s), env);

describe('unit:context-search defaults, canonical', () => {
  it('defaults an empty search', () => {
    const r = read('');
    expect(r.search).toEqual(DEFAULT_CONTEXT);
    expect(r.issues).toEqual([
      { key: 'from', code: 'missing' },
      { key: 'to', code: 'missing' },
      { key: 'refresh', code: 'missing' },
    ]);
    expect(normalisedSearch('', env)).toBe('?from=now-1h&to=now&refresh=off');
  });
  it('accepts canonical searches as they are', () => {
    expect(normalisedSearch('?from=now-6h&to=now&refresh=30s', env)).toBeNull();
    expect(
      normalisedSearch(
        '?from=2026-11-19T12%3A03%3A00.000Z&to=2026-11-19T13%3A03%3A00.000Z&refresh=5m',
        env,
      ),
    ).toBeNull();
  });
});

describe('unit:context-search invalid', () => {
  it('defaults invalid values and reports them', () => {
    const a = read('?from=now-1x&to=now&refresh=7s');
    expect(a.search).toEqual({ from: 'now-1h', to: 'now', refresh: 'off' });
    expect(a.issues).toContainEqual({
      key: 'from',
      code: 'invalid',
      error: { code: 'unknownUnit', unit: 'x' },
    });
    expect(a.issues).toContainEqual({ key: 'refresh', code: 'invalid', value: '7s' });
    expect(read('?refresh=30S').search.refresh).toBe('off');
    const e = read('?from=&to=now');
    expect(e.search.from).toBe('now-1h');
    expect(e.issues).toContainEqual({ key: 'from', code: 'invalid', error: { code: 'empty' } });
    const n = read('?from=now&to=now-1h');
    expect(n.search).toEqual(DEFAULT_CONTEXT);
    expect(n.issues).toContainEqual({ key: 'to', code: 'notAfterFrom' });
  });
});

describe('unit:context-search canonicalises', () => {
  it('drops duplicates, normalises offsets and sorts other keys', () => {
    expect(normalisedSearch('?from=now-6h&from=now-2h&to=now', env)).toBe(
      '?from=now-6h&to=now&refresh=off',
    );
    expect(read('?from=now-6h&from=now-2h&to=now').issues).toContainEqual({
      key: 'from',
      code: 'duplicate',
    });
    const want = '?from=2026-11-19T12%3A03%3A00.000Z&to=now&refresh=off';
    expect(normalisedSearch('?from=2026-11-19T13:03:00+01:00&to=now', env)).toBe(want);
    expect(normalisedSearch('?from=2026-11-19T13:03:00%2B01:00&to=now', env)).toBe(want);
    expect(normalisedSearch('?x=1&refresh=off&a=2&to=now&from=now-1h&a=0', env)).toBe(
      '?from=now-1h&to=now&refresh=off&a=2&a=0&x=1',
    );
  });
});

describe('unit:context-search round-trip', () => {
  it('reads back what it writes for 1 000 valid values', () => {
    const rnd = mulberry32(57);
    const units = ['s', 'm', 'h', 'd', 'w'];
    for (let i = 0; i < 1_000; i++) {
      const from =
        rnd() < 0.5
          ? `now-${String(1 + Math.floor(rnd() * 99_999))}${units[Math.floor(rnd() * 5)] ?? 's'}`
          : new Date(T - (1 + Math.floor(rnd() * 1e9)) * 1_000).toISOString();
      const to = rnd() < 0.5 ? 'now' : new Date(T + Math.floor(rnd() * 1e6) * 1_000).toISOString();
      const s: ContextSearch = {
        from,
        to,
        refresh: REFRESH_INTERVALS[Math.floor(rnd() * REFRESH_INTERVALS.length)] ?? 'off',
      };
      const r = readContextSearch(writeContextSearch(s), env);
      expect(r.search).toEqual(s);
      expect(r.issues).toEqual([]);
    }
  });
});

describe('unit:context-search writer guard', () => {
  it('rejects non-canonical values', () => {
    expect(() => writeContextSearch({ ...DEFAULT_CONTEXT, from: 'yesterday' })).toThrow(RangeError);
    expect(() =>
      writeContextSearch({ ...DEFAULT_CONTEXT, from: '2026-11-19T13:03:00+01:00' }),
    ).toThrow(RangeError);
  });
});
