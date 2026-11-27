/**
 * The geomap's pattern tiles (T24-090; plan #234 Part 2 §2): 6 × 6 CSS px per pattern name, ink and
 * DPR, cached.
 */
import type { Ctx2D } from '../ctx';

export interface PatternTiles {
  /** The repeating pattern of `name` in `ink` for `ctx`; null for `solid` or no canvas. */
  get(ctx: Ctx2D, name: string, ink: string, dpr: number): CanvasPattern | null;
}

export function patternTiles(
  createCanvas: () => HTMLCanvasElement,
  contextOf: (c: HTMLCanvasElement) => Ctx2D | null,
): PatternTiles {
  void createCanvas;
  void contextOf;
  return { get: () => null };
}
