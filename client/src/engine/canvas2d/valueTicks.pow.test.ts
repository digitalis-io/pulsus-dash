/// <reference types="node" />
/**
 * `unit:js-pow` (#126 plan §5, T02-029): the interim tick powers equal V8's `**` as recorded in
 * `engine/fixtures/pow.json` (Node 24.22.3), equal `**` at the edges, and `valueTicks.ts` itself
 * contains no `**`, so every browser engine computes the same powers.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pow10, powBase, SPAN_HALF_LIMIT } from './valueTicks';

interface PowRow {
  readonly base: 10 | 1000 | 1024;
  readonly p: number;
  readonly v: number;
}

const rows = JSON.parse(
  readFileSync(join(process.cwd(), '..', 'engine', 'fixtures', 'pow.json'), 'utf8'),
) as PowRow[];

describe('unit:js-pow', () => {
  it('pow10 and powBase equal every pow.json row', () => {
    expect(rows.length).toBe(855);
    const bad = rows
      .map((r) => ({ r, got: r.base === 10 ? pow10(r.p) : powBase(r.base, r.p) }))
      .filter(({ r, got }) => !Object.is(got, r.v))
      .map(({ r, got }) => `${String(r.base)} ** ${String(r.p)}: ${String(got)} != ${String(r.v)}`);
    expect(bad.length, bad.slice(0, 10).join('\n')).toBe(0);
  });

  it('pow10 and powBase equal ** at the edges', () => {
    expect(pow10(Number.NaN)).toBeNaN();
    expect(Object.is(pow10(-Infinity), 0)).toBe(true);
    expect(Object.is(pow10(-341), 0)).toBe(true);
    expect(pow10(309)).toBe(Infinity);
    expect(pow10(Infinity)).toBe(Infinity);
    expect(powBase(1000, 103)).toBe(Infinity);
    expect(powBase(1024, 103)).toBe(Infinity);
    expect(powBase(1024, Infinity)).toBe(Infinity);
    expect(powBase(1000, -1)).toBeNaN();
    expect(powBase(1000, Number.NaN)).toBeNaN();
    expect(SPAN_HALF_LIMIT).toBe(2 ** 1022);
  });

  it('valueTicks.ts contains no ** outside comments', () => {
    const source = readFileSync(join('src', 'engine', 'canvas2d', 'valueTicks.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/\*\*/);
  });
});
