/**
 * Grid geometry and keyboard layout operations (plan #61 Part B §3.6). A board grid has 12 columns
 * of 40 px rows with 12 px gaps (`size.board-gap`, #282 Part 2a); View and Edit mode both place
 * panels with these numbers.
 */
import type { GridPos, PanelSpec } from '../api/types';
import { size } from '../styles/tokens';

export const COLS = size['board-cols'];
export const ROW = size['board-row'];
export const GAP = size['board-gap'];

/**
 * The server's grid rules (`server/internal/spec/validate.go`: `gridColumns`, `maxGridRow`,
 * `maxGridRowSpan`; no bound on `y + h`). The one limit set used by `checkBoardSpec`, `applyOp`,
 * `firstFree` and both grids.
 */
export const GRID_LIMITS = { cols: 12, maxY: 9999, maxH: 100, maxBottom: 9999 + 100 } as const;

export type LayoutOp =
  'left' | 'right' | 'up' | 'down' | 'narrower' | 'wider' | 'shorter' | 'taller';

export interface OpResult {
  panels: PanelSpec[];
  moved: boolean;
}

/** 0 ≤ x, 1 ≤ w, x + w ≤ 12, 0 ≤ y ≤ 9999, 1 ≤ h ≤ 100. */
export function fits(g: GridPos): boolean {
  return (
    g.x >= 0 &&
    g.w >= 1 &&
    g.x + g.w <= GRID_LIMITS.cols &&
    g.y >= 0 &&
    g.y <= GRID_LIMITS.maxY &&
    g.h >= 1 &&
    g.h <= GRID_LIMITS.maxH
  );
}

export function overlaps(a: GridPos, b: GridPos): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** True when `g` fits and overlaps no panel of `panels` other than `except`. */
export function placeable(g: GridPos, panels: readonly PanelSpec[], except?: string): boolean {
  return fits(g) && !panels.some((p) => p.id !== except && overlaps(p.grid, g));
}

/**
 * The first free `(x, y)` in `(y, x)` order for a `w × h` panel, or `null` when none fits. The first
 * free slot always lies on a line `y ∈ {0} ∪ {p.y + p.h}` and `x ∈ {0} ∪ {p.x + p.w}`, so only those
 * are tried.
 */
export function firstFree(panels: readonly PanelSpec[], w: number, h: number): GridPos | null {
  const ys = [...new Set([0, ...panels.map((p) => p.grid.y + p.grid.h)])].sort((a, b) => a - b);
  const xs = [...new Set([0, ...panels.map((p) => p.grid.x + p.grid.w)])].sort((a, b) => a - b);
  for (const y of ys) {
    if (y > GRID_LIMITS.maxY) break;
    for (const x of xs) {
      const g = { x, y, w, h };
      if (placeable(g, panels)) return g;
    }
  }
  return null;
}

const DELTA: Readonly<Record<LayoutOp, Readonly<Partial<GridPos>>>> = {
  left: { x: -1 },
  right: { x: 1 },
  up: { y: -1 },
  down: { y: 1 },
  narrower: { w: -1 },
  wider: { w: 1 },
  shorter: { h: -1 },
  taller: { h: 1 },
};

/**
 * Moves or resizes one panel by one cell. Only the target changes; the op is blocked (input
 * returned unchanged, `moved: false`) when the result does not fit or overlaps another panel. No
 * other panel moves and no gap closes.
 */
export function applyOp(panels: readonly PanelSpec[], id: string, op: LayoutOp): OpResult {
  const target = panels.find((p) => p.id === id);
  if (target === undefined) return { panels: [...panels], moved: false };
  const d = DELTA[op];
  const g = target.grid;
  const next: GridPos = {
    x: g.x + (d.x ?? 0),
    y: g.y + (d.y ?? 0),
    w: g.w + (d.w ?? 0),
    h: g.h + (d.h ?? 0),
  };
  if (!placeable(next, panels, id)) return { panels: [...panels], moved: false };
  return { panels: panels.map((p) => (p.id === id ? { ...p, grid: next } : p)), moved: true };
}

/** The width of one column for a grid `widthPx` wide: `(widthPx − 11 · 16) / 12`. */
export function cellPx(widthPx: number): number {
  return (widthPx - (COLS - 1) * GAP) / COLS;
}
