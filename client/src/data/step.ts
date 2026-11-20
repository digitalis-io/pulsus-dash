/** Mirror of the BFF's `PromGrid` for stub mode; the BFF's grid is authoritative. Stub. */
export interface Grid {
  readonly startMs: number;
  readonly endMs: number;
  readonly stepMs: number;
}

export const LADDER_MS: readonly number[] = [];

export function promGrid(_fromMs: number, _toMs: number, _widthPx: number): Grid | null {
  return null;
}
