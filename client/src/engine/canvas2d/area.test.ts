/**
 * `unit:area-pieces` (#282 Part 2b §5; ADR-0036): `areaPieces` in value space gives each
 * `engine/fixtures/area-pieces.json` case's pieces within ±1 px (the parity contract), and never
 * projects an out-of-range value: every coordinate is finite, also on a subnormal span (e6).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { areaPieces, type AreaPiece } from './area';

interface Row {
  case: string;
  x0: number;
  x1: number;
  va: number;
  vb: number;
  min: number;
  max: number;
  top: number;
  bottom: number;
  pieces: AreaPiece[];
}

const ROWS = JSON.parse(
  readFileSync(join(process.cwd(), '..', 'engine', 'fixtures', 'area-pieces.json'), 'utf8'),
) as Row[];

const wide = (p: AreaPiece): boolean => p.x1 - p.x0 > 1;

describe('areaPieces', () => {
  it('has the twelve fixture cases', () => {
    expect(ROWS.map((r) => r.case)).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e1',
      'e2',
      'e3',
      'e4',
      'e5',
      'e6a',
      'e6b',
      'f',
    ]);
  });

  for (const r of ROWS) {
    it(`case ${r.case}: the fixture's pieces within 1 px, all finite`, () => {
      const got = areaPieces(r.x0, r.x1, r.va, r.vb, r.min, r.max, r.top, r.bottom - r.top);
      for (const p of got) {
        for (const v of [p.x0, p.x1, p.y0, p.y1]) expect(Number.isFinite(v)).toBe(true);
        expect(p.x0).toBeLessThanOrEqual(p.x1);
      }
      if (r.pieces.length === 0) {
        expect(got).toEqual([]);
        return;
      }
      const g = got.filter(wide);
      const w = r.pieces.filter(wide);
      expect(g.map((p) => p.cls)).toEqual(w.map((p) => p.cls));
      g.forEach((p, k) => {
        const e = w[k];
        if (e === undefined) throw new Error('missing piece');
        for (const key of ['x0', 'x1', 'y0', 'y1'] as const) {
          expect(Math.abs(p[key] - e[key])).toBeLessThanOrEqual(1);
        }
      });
    });
  }

  it('(e6) projects a subnormal span fraction first: y 300 at x 0, 200 at x 50, 100 at x 100', () => {
    const a = areaPieces(0, 50, 0, 5e-309, 0, 1e-308, 100, 200);
    const b = areaPieces(50, 100, 5e-309, 1e-308, 0, 1e-308, 100, 200);
    expect(a.map((p) => [p.cls, p.x0, p.y0, p.x1, p.y1])).toEqual([['I', 0, 300, 50, 200]]);
    expect(b.map((p) => [p.cls, p.x0, p.y0, p.x1, p.y1])).toEqual([['I', 50, 200, 100, 100]]);
  });
});
