import { describe, expect, it } from 'vitest';
import { T } from '../test/renderApp';
import { contextReducer, type ContextAction } from './contextReducer';
import type { ContextSearch } from './contextSearch';

const env = { nowMs: T, timeZone: 'Europe/London' };
const abs = (from: string, to: string): ContextSearch => ({
  from: `2026-11-19T${from}:00.000Z`,
  to: `2026-11-19T${to}:00.000Z`,
  refresh: 'off',
});
const STEP_BACK: ContextAction = { type: 'step', dir: -1 };
const STEP_FWD: ContextAction = { type: 'step', dir: 1 };
const OUT: ContextAction = { type: 'zoom', dir: 'out' };
const IN: ContextAction = { type: 'zoom', dir: 'in' };

describe('unit:context-reducer keys', () => {
  it('steps and zooms 10:00–11:00', () => {
    const s = abs('10:00', '11:00');
    expect(contextReducer(s, STEP_FWD, env)).toEqual(abs('11:00', '12:00'));
    expect(contextReducer(s, STEP_BACK, env)).toEqual(abs('09:00', '10:00'));
    expect(contextReducer(s, OUT, env)).toEqual(abs('09:30', '11:30'));
    expect(contextReducer(s, IN, env)).toEqual(abs('10:15', '10:45'));
  });

  it('INT-032 from 12:03–13:03; - then = restores', () => {
    const s = abs('12:03', '13:03');
    expect(contextReducer(s, STEP_BACK, env)).toEqual(abs('11:03', '12:03'));
    expect(contextReducer(s, OUT, env)).toEqual(abs('11:33', '13:33'));
    expect(contextReducer(s, IN, env)).toEqual(abs('12:18', '12:48'));
    expect(contextReducer(contextReducer(s, OUT, env), IN, env)).toEqual(s);
  });

  it('a relative range steps to absolute times', () => {
    const s: ContextSearch = { from: 'now-1h', to: 'now', refresh: 'off' };
    expect(contextReducer(s, STEP_BACK, env)).toEqual(abs('11:03', '12:03'));
  });
});

describe('unit:context-reducer no-ops', () => {
  it('returns the same object for no-ops and invalid actions', () => {
    const narrow: ContextSearch = {
      from: '2026-11-19T10:00:00.000Z',
      to: '2026-11-19T10:00:01.500Z',
      refresh: 'off',
    };
    expect(contextReducer(narrow, IN, env)).toBe(narrow);
    const s: ContextSearch = { from: 'now-1h', to: 'now', refresh: 'off' };
    expect(contextReducer(s, { type: 'setRange', from: 'now', to: 'now-1h' }, env)).toBe(s);
    expect(contextReducer(s, { type: 'setRange', from: 'now-1x', to: 'now' }, env)).toBe(s);
  });
});
