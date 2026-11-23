/// <reference types="node" />
/**
 * `unit:value-ticks-bounded` (#97 plan §5 A): the interim `valueTicks` returns finite, bounded
 * ticks for every finite domain. Each row runs `scripts/value-ticks-probe.ts` in a child process
 * killed after 5 s (10 s for the property and draw rows), so a search that never finishes fails
 * here instead of hanging the run.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const M = Number.MAX_VALUE;
const H = M / 2; // 8.988465674311579e307
const Q = 1.3482698511467367e308; // H/2 + M/2

/** Runs the probe and returns its JSON line, non-finite strings turned back into numbers. */
function probe(args: readonly string[], timeout: number): Record<string, unknown> {
  const r = spawnSync(process.execPath, [join('scripts', 'value-ticks-probe.ts'), ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout,
    killSignal: 'SIGKILL',
  });
  expect(r.signal, `probe ${args.join(' ')} was killed: ${r.stderr}`).toBeNull();
  expect(r.status, r.stderr).toBe(0);
  const special: Record<string, number> = { NaN, Infinity, '-Infinity': -Infinity };
  return JSON.parse(r.stdout, (_k, v: unknown) =>
    typeof v === 'string' && v in special ? special[v] : v,
  ) as Record<string, unknown>;
}

interface Out {
  readonly min: number;
  readonly max: number;
  readonly ticks: readonly number[];
  readonly y: readonly number[];
}

function ticks(min: number, max: number, h = 200, base: 1000 | 1024 = 1000): Out {
  const args = [min, max, h, 14, base].map(String);
  return probe(['ticks', ...args], 5_000) as unknown as Out;
}

const exact = (o: Out): { min: number; max: number; ticks: readonly number[] } => ({
  min: o.min,
  max: o.max,
  ticks: o.ticks,
});

type Row = readonly [
  id: string,
  min: number,
  max: number,
  h: number,
  base: 1000 | 1024,
  want: { min: number; max: number; ticks: number[] },
];

/** Rows with an exact `{min, max, ticks}` (label 14). */
const EXACT: readonly Row[] = [
  ['A1', -M, M, 200, 1000, { min: -M, max: M, ticks: [-M, 0, M] }],
  ['A2', H, M, 200, 1000, { min: H, max: M, ticks: [H, Q, M] }],
  ['A3', -M, -H, 200, 1000, { min: -M, max: -H, ticks: [-M, -Q, -H] }],
  ['A4', -M, 1, 200, 1000, { min: -M, max: 1, ticks: [-M, -8.988465674311579e307, 1] }],
  ['A5', -1e308, 1e308, 200, 1000, { min: -1e308, max: 1e308, ticks: [-1e308, 0, 1e308] }],
  ['A6', 1e17, 1e17, 200, 1000, { min: 5e16, max: 1e17, ticks: [5e16, 7.5e16, 1e17] }],
  ['A7', -1e17, -1e17, 200, 1000, { min: -1e17, max: -5e16, ticks: [-1e17, -7.5e16, -5e16] }],
  ['A8', M, M, 200, 1000, { min: H, max: M, ticks: [H, Q, M] }],
  ['A9', -M, -M, 200, 1000, { min: -M, max: -H, ticks: [-M, -Q, -H] }],
  ['A10', 0, 5e-324, 200, 1000, { min: 0, max: 5e-324, ticks: [0, 5e-324] }],
  ['A11', 5e-324, 1e-323, 200, 1000, { min: 5e-324, max: 1e-323, ticks: [5e-324, 1e-323] }],
  ['A12', -5e-324, 5e-324, 200, 1000, { min: -5e-324, max: 5e-324, ticks: [-5e-324, 0, 5e-324] }],
  ['A13', -1.7e-6, 4e-6, 21, 1024, { min: -1.7e-6, max: 4e-6, ticks: [-1.7e-6, 4e-6] }],
  ['A14', -1, 1, 0, 1000, { min: -1, max: 1, ticks: [-1] }],
  ['A15', 0, M, 200, 1024, { min: 0, max: M, ticks: [0, H, M] }],
  ['A16', 0, 1e301, 200, 1000, { min: 0, max: 1e301, ticks: [0, 5e300, 1e301] }],
  ['A17', 0, 0, 200, 1000, { min: 0, max: 1, ticks: [0, 0.2, 0.4, 0.6, 0.8, 1] }],
  ['A20', 5e-324, 5e-324, 200, 1000, { min: 0, max: 1, ticks: [0, 0.2, 0.4, 0.6, 0.8, 1] }],
  ['A21', -M, M, 32, 1000, { min: -M, max: M, ticks: [-M, 0, M] }],
  ['A22', -M, M, 31.5, 1000, { min: -M, max: M, ticks: [-M, M] }],
  ['A23', -M, M, 16, 1000, { min: -M, max: M, ticks: [-M, M] }],
  ['A24', -M, M, 15.5, 1000, { min: -M, max: M, ticks: [-M] }],
  ['A25', 1, M, 15.5, 1000, { min: 1, max: M, ticks: [1] }],
  ['A26', -M, -1, 15.5, 1000, { min: -M, max: -1, ticks: [-1] }],
  ['A27', 0, 1, 16, 1000, { min: 0, max: 1, ticks: [0, 1] }],
  ['A28', 0, 1, 15.5, 1000, { min: 0, max: 1, ticks: [0] }],
  ['A29', -3, 1, 10, 1000, { min: -3, max: 1, ticks: [1] }],
  ['A30', 0, 1, 40, 1000, { min: 0, max: 1, ticks: [0, 0.5, 1] }],
  [
    'A34',
    2615306150439.0483,
    2615306150439.0483,
    1026,
    1000,
    {
      min: 1307653075219.5242,
      max: 2615306150439.0483,
      ticks: [1307653075219.5242, 1961479612829.2861, 2615306150439.0483],
    },
  ],
];

describe('unit:value-ticks-bounded', () => {
  for (const [id, min, max, h, base, want] of EXACT) {
    it(`${id}: valueTicks(${String(min)}, ${String(max)}, h ${String(h)}, base ${String(base)})`, () => {
      expect(exact(ticks(min, max, h, base))).toEqual(want);
    }, 15_000);
  }

  it('A18: valueTicks(-1e300, 1e300) is nice and bounded', () => {
    const o = ticks(-1e300, 1e300);
    expect(o.ticks).toEqual([-1e300, -5e299, 0, 5e299, 1e300]);
    expect(o.min).toBeLessThanOrEqual(-1e300);
    expect(o.max).toBeGreaterThanOrEqual(1e300);
  }, 15_000);

  it('A19: valueTicks(1e-310, 3e-310) is nice and bounded', () => {
    const o = ticks(1e-310, 3e-310);
    expect(o.ticks).toEqual([1e-310, 1.5e-310, 2e-310, 2.5e-310, 3e-310, 3.5e-310]);
    expect(o.min).toBeLessThanOrEqual(1e-310);
    expect(o.max).toBeGreaterThanOrEqual(3e-310);
  }, 15_000);

  it('A33: a rounded duplicate fails the collision check and falls back', () => {
    const o = ticks(1, 1 + 1e-11);
    expect(exact(o)).toEqual({
      min: 1,
      max: 1.00000000001,
      ticks: [1, 1.000000000005, 1.00000000001],
    });
    expect(o.y).toEqual([200, 100, 0]);
  }, 15_000);

  it('A31: prop 97 10000 holds P1 to P7', () => {
    const o = probe(['prop', '97', '10000'], 10_000);
    expect({ cases: o['cases'], violations: o['violations'] }).toEqual({
      cases: 10_000,
      violations: [],
    });
    expect(o['fallbacks']).toBeGreaterThan(0);
  }, 15_000);

  it('A32: the line-extreme entry draws finite paths and three labels', () => {
    const o = probe(['draw'], 10_000) as {
      valueAxis: unknown;
      labels: string[];
      path: Record<string, number>;
      nonFinite: number;
    };
    expect(o.valueAxis).toEqual({ min: -M, max: M, manual: false });
    expect(o.labels).toHaveLength(3);
    expect(o.labels[1]).toBe('0');
    expect(o.path['moveTo']).toBeGreaterThanOrEqual(1);
    expect(o.path['lineTo']).toBeGreaterThanOrEqual(500);
    expect(o.path['runs']).toBeGreaterThanOrEqual(1);
    expect(o.path['nonFinite']).toBe(0);
    expect(o.path['outside']).toBe(0);
    expect(o.nonFinite).toBe(0);
  }, 15_000);
});
