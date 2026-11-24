// unit:logs-params (plan #66 Part C §3.1, §5.1; IA-022).
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOGS, normalisedLogsSearch, readLogsParams, writeLogsParams } from './logsParams';

const ENV = { nowMs: Date.UTC(2026, 10, 19, 13, 3), timeZone: 'Europe/London' };
const CTX = '?from=now-1h&to=now&refresh=off';

describe('unit:logs-params', () => {
  it('reads the defaults from an empty search', () => {
    expect(readLogsParams([])).toEqual(DEFAULT_LOGS);
    expect(DEFAULT_LOGS).toEqual({ q: '', dir: 'backward', wrap: false });
  });

  it('reads dir: only forward is oldest first', () => {
    expect(readLogsParams([['dir', 'forward']]).dir).toBe('forward');
    expect(readLogsParams([['dir', 'up']]).dir).toBe('backward');
    expect(readLogsParams([['dir', 'backward']]).dir).toBe('backward');
  });

  it('reads wrap: only on wraps', () => {
    expect(readLogsParams([['wrap', 'on']]).wrap).toBe(true);
    expect(readLogsParams([['wrap', '1']]).wrap).toBe(false);
  });

  it('the first value of each key wins', () => {
    expect(
      readLogsParams([
        ['q', '{a="b"}'],
        ['q', 'x'],
        ['dir', 'up'],
        ['dir', 'forward'],
        ['wrap', 'off'],
        ['wrap', 'on'],
      ]),
    ).toEqual({ q: '{a="b"}', dir: 'backward', wrap: false });
  });

  it('writes no key for the defaults', () => {
    expect(
      writeLogsParams(
        [
          ['q', 'x'],
          ['dir', 'forward'],
          ['wrap', 'on'],
        ],
        DEFAULT_LOGS,
      ),
    ).toEqual([]);
  });

  it('writes the non-default keys sorted with the rest, keeping other keys', () => {
    expect(
      writeLogsParams(
        [
          ['vis', 'bars'],
          ['a', '1'],
          ['rate', 'off'],
          ['zz', '2'],
        ],
        { q: '{a="b"}', dir: 'forward', wrap: true },
      ),
    ).toEqual([
      ['a', '1'],
      ['dir', 'forward'],
      ['q', '{a="b"}'],
      ['rate', 'off'],
      ['vis', 'bars'],
      ['wrap', 'on'],
      ['zz', '2'],
    ]);
  });

  it('normalises to the canonical search', () => {
    expect(normalisedLogsSearch(`${CTX}&wrap=1&q=x`, ENV)).toBe(`${CTX}&q=x`);
    expect(normalisedLogsSearch(`${CTX}&dir=forward&q=x&wrap=on`, ENV)).toBeNull();
    expect(normalisedLogsSearch(`${CTX}&q=x&dir=forward`, ENV)).toBe(`${CTX}&dir=forward&q=x`);
  });
});
