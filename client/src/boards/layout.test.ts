import { describe, expect, it } from 'vitest';
import type { GridPos, PanelSpec } from '../api/types';
import { applyOp, cellPx, firstFree, type LayoutOp } from './layout';

function panel(id: string, x: number, y: number, w: number, h: number): PanelSpec {
  return {
    id,
    title: id,
    grid: { x, y, w, h },
    query: { lang: 'promql', text: 'up' },
    vis: { kind: 'line' },
  };
}

const at = (x: number, y: number, w: number, h: number): GridPos => ({ x, y, w, h });

function grids(panels: readonly PanelSpec[]): Record<string, string> {
  return Object.fromEntries(
    panels.map((p) => [p.id, [p.grid.x, p.grid.y, p.grid.w, p.grid.h].join(',')]),
  );
}

/** Applies `op` to `id` and checks that only the target's grid can have changed. */
function step(
  panels: PanelSpec[],
  id: string,
  op: LayoutOp,
): { panels: PanelSpec[]; moved: boolean } {
  const r = applyOp(panels, id, op);
  for (const p of r.panels) {
    if (p.id !== id) expect(p, `${op} moved ${p.id}`).toEqual(panels.find((q) => q.id === p.id));
  }
  if (!r.moved) expect(r.panels).toEqual(panels);
  return r;
}

describe('layout', () => {
  it('firstFree', () => {
    const panels: PanelSpec[] = [];
    const want = [at(0, 0, 6, 8), at(6, 0, 6, 8), at(0, 8, 6, 8)];
    for (const [i, w] of want.entries()) {
      const g = firstFree(panels, 6, 8);
      expect(g).toEqual(w);
      if (g !== null) panels.push(panel(`p-${String(i + 1)}`, g.x, g.y, g.w, g.h));
    }
  });

  it('firstFree full', () => {
    const panels = Array.from({ length: 100 }, (_, i) =>
      panel(`p-${String(i)}`, 0, i * 100, 12, 100),
    );
    expect(firstFree(panels, 6, 8)).toBeNull();
    expect(firstFree(panels.slice(0, 99), 6, 8)).toEqual(at(0, 9900, 6, 8));
  });

  it('firstFree at the max row', () => {
    const panels = Array.from({ length: 100 }, (_, i) =>
      panel(`p-${String(i)}`, 0, i * 100, 12, i === 99 ? 99 : 100),
    );
    expect(firstFree(panels, 6, 8)).toEqual(at(0, 9999, 6, 8));
  });

  it('applyOp', () => {
    let ps = [panel('A', 0, 0, 6, 8), panel('B', 6, 0, 6, 8), panel('C', 0, 8, 6, 8)];
    for (let i = 0; i < 6; i++) {
      const r = step(ps, 'C', 'right');
      expect(r.moved).toBe(true);
      ps = r.panels;
    }
    expect(grids(ps)['C']).toBe('6,8,6,8');
    let r = step(ps, 'C', 'right');
    expect(r.moved).toBe(false);
    expect(grids(r.panels)['C']).toBe('6,8,6,8');
    for (let i = 0; i < 2; i++) ps = step(ps, 'C', 'taller').panels;
    expect(grids(ps)['C']).toBe('6,8,6,10');
    r = step(ps, 'A', 'down');
    expect(r.moved).toBe(true);
    ps = r.panels;
    expect(grids(ps)).toEqual({ A: '0,1,6,8', B: '6,0,6,8', C: '6,8,6,10' });
    r = step(ps, 'B', 'down');
    expect(r.moved).toBe(false);
    expect(grids(r.panels)).toEqual({ A: '0,1,6,8', B: '6,0,6,8', C: '6,8,6,10' });
    expect(step(ps, 'A', 'left').moved).toBe(false);
    expect(step(ps, 'B', 'wider').moved).toBe(false);
    const thin = [panel('T', 3, 0, 1, 2)];
    expect(step(thin, 'T', 'narrower').moved).toBe(false);
  });

  it('applyOp sparse', () => {
    const ps = [panel('D', 0, 20, 6, 8), panel('E', 6, 3, 6, 4)];
    const up = step(ps, 'D', 'up');
    expect(up.moved).toBe(true);
    expect(grids(up.panels)).toEqual({ D: '0,19,6,8', E: '6,3,6,4' });
    const right = step(ps, 'D', 'right');
    expect(right.moved).toBe(true);
    expect(grids(right.panels)).toEqual({ D: '1,20,6,8', E: '6,3,6,4' });
  });

  it('applyOp row limits', () => {
    const ps = [panel('F', 0, 9999, 6, 1), panel('G', 6, 0, 6, 100)];
    expect(step(ps, 'F', 'down').moved).toBe(false);
    const taller = step(ps, 'F', 'taller');
    expect(taller.moved).toBe(true);
    expect(grids(taller.panels)['F']).toBe('0,9999,6,2');
    expect(step(ps, 'G', 'taller').moved).toBe(false);
    expect(step(ps, 'G', 'up').moved).toBe(false);
  });

  it('cellPx', () => {
    expect(cellPx(1152)).toBeCloseTo((1152 - 11 * 16) / 12, 6);
  });
});
