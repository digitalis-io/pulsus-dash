import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../test/random';
import { T } from '../test/renderApp';
import {
  parseTimeExpr,
  printTimeExpr,
  resolveTimeExpr,
  timeExprErrorMessage,
  type TimeExpr,
  type TimeUnit,
} from './timeExpr';

const LONDON = 'Europe/London';

function expr(s: string): TimeExpr {
  const r = parseTimeExpr(s);
  if (!r.ok) throw new Error(`does not parse: ${s}`);
  return r.expr;
}

const iso = (ms: number): string => new Date(ms).toISOString();

describe('unit:time-expr', () => {
  it('resolves now-1h and now', () => {
    expect(resolveTimeExpr(expr('now-1h'), T, LONDON)).toBe(T - 3_600_000);
    expect(resolveTimeExpr(expr('now'), T, LONDON)).toBe(T);
  });

  it('now/d is the start of the day in the zone', () => {
    expect(iso(resolveTimeExpr(expr('now/d'), T, LONDON))).toBe('2026-11-19T00:00:00.000Z');
    expect(
      iso(resolveTimeExpr(expr('now/d'), Date.parse('2026-11-19T03:00:00Z'), 'America/New_York')),
    ).toBe('2026-11-18T05:00:00.000Z');
    expect(iso(resolveTimeExpr(expr('now/d'), Date.parse('2026-03-29T12:00:00Z'), LONDON))).toBe(
      '2026-03-29T00:00:00.000Z',
    );
  });

  it('names an unknown unit', () => {
    const r = parseTimeExpr('now-1x');
    expect(r).toEqual({ ok: false, error: { code: 'unknownUnit', unit: 'x' } });
    if (r.ok) return;
    const msg = timeExprErrorMessage(r.error);
    expect(msg).toContain('“x”');
    expect(msg).toContain('s, m, h, d or w');
  });

  it.each([
    ['', 'empty'],
    ['now-', 'syntax'],
    ['now-0m', 'outOfRange'],
    ['now-01h', 'badNumber'],
    ['now - 1h', 'syntax'],
    ['now-100000d', 'outOfRange'],
    ['2026-13-01T00:00:00Z', 'syntax'],
    ['yesterday', 'syntax'],
  ])('rejects %j with %s', (s, code) => {
    const r = parseTimeExpr(s);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(code);
  });

  it('print∘parse is the identity on canonical text, and parse∘print on expressions', () => {
    for (const s of [
      'now',
      'now/d',
      'now-5m',
      'now-90m',
      'now-2d',
      'now-1w',
      '2026-11-19T12:03:00.000Z',
    ]) {
      expect(printTimeExpr(expr(s))).toBe(s);
    }
    const rnd = mulberry32(57);
    const units: TimeUnit[] = ['s', 'm', 'h', 'd', 'w'];
    for (let i = 0; i < 1_000; i++) {
      const k = Math.floor(rnd() * 4);
      let e: TimeExpr;
      if (k === 0) e = { kind: 'now' };
      else if (k === 1) e = { kind: 'startOfDay' };
      else if (k === 2)
        e = {
          kind: 'ago',
          n: 1 + Math.floor(rnd() * 99_999),
          unit: units[Math.floor(rnd() * 5)] ?? 's',
        };
      else e = { kind: 'absolute', ms: Math.floor(rnd() * Date.UTC(9999, 0, 1)) };
      expect(parseTimeExpr(printTimeExpr(e))).toEqual({ ok: true, expr: e });
    }
  });

  it('normalises an offset to UTC', () => {
    const e = expr('2026-11-19T13:03:00+01:00');
    expect(e).toEqual({ kind: 'absolute', ms: Date.UTC(2026, 10, 19, 12, 3) });
    expect(printTimeExpr(e)).toBe('2026-11-19T12:03:00.000Z');
  });
});
