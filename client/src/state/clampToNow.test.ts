import { describe, expect, it } from 'vitest';
import { T } from '../test/renderApp';
import { agoExpr, clampToNow } from './clampToNow';
import { contextReducer } from './contextReducer';
import type { ContextSearch } from './contextSearch';

const H = 3_600_000;
const env = { nowMs: T, timeZone: 'Europe/London' };
const iso = (ms: number): string => new Date(ms).toISOString();

describe('unit:clamp-to-now', () => {
  it('a zoom-out near now ends at now and keeps its width', () => {
    const next = { fromMs: T - 1.5 * H, toMs: T + 0.5 * H };
    expect(clampToNow(next, T, T)).toEqual({ fromMs: T - 2 * H, toMs: T });
  });

  it('a zoom-out far in the past is unchanged', () => {
    const next = { fromMs: T - 30 * H, toMs: T - 28 * H };
    expect(clampToNow(next, T - 28.5 * H, T)).toBe(next);
  });

  it('a move that does not push the end later is unchanged', () => {
    const next = { fromMs: T + 0.25 * H, toMs: T + 0.75 * H };
    expect(clampToNow(next, T + H, T)).toBe(next);
  });

  it('the key and chart paths clamp an absolute range at now', () => {
    const s: ContextSearch = { from: iso(T - H), to: iso(T), refresh: 'off' };
    expect(contextReducer(s, { type: 'zoom', dir: 'out' }, env)).toEqual({
      ...s,
      from: iso(T - 2 * H),
      to: iso(T),
    });
    // Panning forward at the live edge is a no-op.
    expect(contextReducer(s, { type: 'step', dir: 1 }, env)).toBe(s);
    const chart = { type: 'chartWindow', fromMs: T - 1.5 * H, toMs: T + 0.5 * H } as const;
    expect(contextReducer(s, chart, env)).toEqual({ ...s, from: iso(T - 2 * H), to: iso(T) });
  });

  it('a relative range ending at now stays relative', () => {
    const s: ContextSearch = { from: 'now-1h', to: 'now', refresh: 'off' };
    expect(contextReducer(s, { type: 'zoom', dir: 'out' }, env)).toEqual({ ...s, from: 'now-2h' });
    const chart = { type: 'chartWindow', fromMs: T - 2 * H, toMs: T + H } as const;
    expect(contextReducer(s, chart, env)).toEqual({ ...s, from: 'now-3h' });
    // Zooming in is unchanged: absolute times.
    expect(contextReducer(s, { type: 'zoom', dir: 'in' }, env)).toEqual({
      ...s,
      from: iso(T - 0.75 * H),
      to: iso(T - 0.25 * H),
    });
  });

  it('names a width in whole units, or null', () => {
    expect(agoExpr(2 * H)).toBe('now-2h');
    expect(agoExpr(90 * 60_000)).toBe('now-90m');
    expect(agoExpr(14 * 86_400_000)).toBe('now-2w');
    expect(agoExpr(1_500)).toBeNull();
  });
});
