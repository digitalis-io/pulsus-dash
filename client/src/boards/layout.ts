/** Grid geometry and keyboard layout operations (plan #61 Part B §3.6). Stub. */
import type { GridPos, PanelSpec } from '../api/types';
import { size, space } from '../styles/tokens';

export const COLS = size['board-cols'];
export const ROW = size['board-row'];
export const GAP = space['4'];

export const GRID_LIMITS = { cols: 12, maxY: 9999, maxH: 100, maxBottom: 9999 + 100 } as const;

export type LayoutOp =
  'left' | 'right' | 'up' | 'down' | 'narrower' | 'wider' | 'shorter' | 'taller';
export interface OpResult {
  panels: PanelSpec[];
  moved: boolean;
}

export function fits(_g: GridPos): boolean {
  return true;
}

export function firstFree(_panels: readonly PanelSpec[], w: number, h: number): GridPos | null {
  return { x: 0, y: 0, w, h };
}

export function applyOp(panels: readonly PanelSpec[], _id: string, _op: LayoutOp): OpResult {
  return { panels: [...panels], moved: false };
}

export function cellPx(_widthPx: number): number {
  return 0;
}
