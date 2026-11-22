import { describe, expect, it } from 'vitest';
import { readContextSearch } from '../state/contextSearch';
import { boardTimeInit, isTimeReady, type TimeInit } from './boardTime';

const env = { nowMs: Date.UTC(2026, 10, 19, 13, 3), timeZone: 'Europe/London' };
const init = (search: string, linkState: boolean, saved?: { from: string; to: string }) =>
  boardTimeInit({ search, linkState, saved, ...env });

describe('boardTimeInit and isTimeReady', () => {
  it('I1: no time in the URL, a saved time', () => {
    for (const linkState of [false, true]) {
      expect(init('', linkState, { from: 'now-6h', to: 'now' })).toEqual({
        search: '?from=now-6h&to=now&refresh=off',
        from: 'now-6h',
        to: 'now',
        tick: true,
      });
    }
    // Other keys and the refresh interval are kept.
    expect(init('?var-a=1&refresh=10s', false, { from: 'now-6h', to: 'now' })).toEqual({
      search: '?from=now-6h&to=now&refresh=10s&var-a=1',
      from: 'now-6h',
      to: 'now',
      tick: true,
    });
    // The saved time equals the default: no tick.
    expect(init('', false, { from: 'now-1h', to: 'now' })?.tick).toBe(false);
  });

  it('I2: no time in the URL, none saved', () => {
    expect(init('?var-a=1', false)).toEqual({
      search: '?from=now-1h&to=now&refresh=off&var-a=1',
      from: 'now-1h',
      to: 'now',
      tick: false,
    });
  });

  it('I3: a board link over a URL time', () => {
    expect(init('?from=now-1h&to=now&refresh=off', true, { from: 'now-6h', to: 'now' })).toEqual({
      search: '?from=now-6h&to=now&refresh=off',
      from: 'now-6h',
      to: 'now',
      tick: true,
    });
    expect(init('?from=now-6h&to=now&refresh=off', true, { from: 'now-6h', to: 'now' })).toBeNull();
  });

  it('I4: otherwise the URL time stands', () => {
    expect(
      init('?from=now-1h&to=now&refresh=off', false, { from: 'now-6h', to: 'now' }),
    ).toBeNull();
    expect(init('?from=now-1h&to=now&refresh=off', true)).toBeNull();
    expect(init('?from=now-1h&to=now&refresh=off', false)).toBeNull();
  });

  it('a saved time the reducer rejects targets the parsed window', () => {
    expect(init('', false, { from: 'now', to: 'now-1h' })).toEqual({
      search: '?from=now-1h&to=now&refresh=off',
      from: 'now-1h',
      to: 'now',
      tick: false,
    });
  });

  it('isTimeReady', () => {
    const at = (s: string) => {
      const params = new URLSearchParams(s);
      return { params, search: readContextSearch(params, env).search };
    };
    const a = at('?from=now-6h&to=now&refresh=off');
    const target: TimeInit = {
      search: '?from=now-6h&to=now&refresh=off',
      from: 'now-6h',
      to: 'now',
      tick: true,
    };
    expect(isTimeReady(undefined, a.params, a.search)).toBe(false);
    expect(isTimeReady('url', a.params, a.search)).toBe(true);
    expect(isTimeReady(target, a.params, a.search)).toBe(true);
    const b = at('?from=now-1h&to=now&refresh=off');
    expect(isTimeReady(target, b.params, b.search)).toBe(false);
    // The defaults read from a URL without a time are not the target's, even when equal.
    const c = at('');
    expect(isTimeReady({ ...target, from: 'now-1h' }, c.params, c.search)).toBe(false);
  });
});
