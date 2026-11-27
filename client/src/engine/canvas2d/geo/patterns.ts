/**
 * The geomap's pattern tiles (T24-090, T21-003; plan #234 Part 2 §2): one 6 × 6 CSS px tile per
 * pattern name, ink and DPR, drawn once at the DPR's resolution and cached; each context gets its
 * repeating pattern once, scaled back to CSS px so the strokes stay crisp. `solid` has no tile.
 */
import { HEALTH_PATTERN } from '../../patterns';
import type { Ctx2D } from '../ctx';

/** The tile's side, CSS px. */
export const TILE_CSS = 6;

export interface PatternTiles {
  /** The repeating pattern of `name` in `ink` for `ctx`; null for `solid` or no canvas. */
  get(ctx: Ctx2D, name: string, ink: string, dpr: number): CanvasPattern | null;
}

type Seg = readonly [number, number, number, number];

/** Each pattern's strokes in the 6 px tile (seamless when repeated). */
const STROKES: Readonly<Record<string, readonly Seg[]>> = {
  backDiagonal: [
    [-1, -1, 7, 7],
    [-1, 5, 1, 7],
    [5, -1, 7, 1],
  ],
  hatch: [
    [-1, 7, 7, -1],
    [-1, 1, 1, -1],
    [5, 7, 7, 5],
  ],
  horizontal: [[0, 3.5, 6, 3.5]],
  vertical: [[3.5, 0, 3.5, 6]],
  crossHatch: [
    [-1, -1, 7, 7],
    [-1, 7, 7, -1],
  ],
  dashes: [[0.5, 3.5, 3.5, 3.5]],
  grid: [
    [0.5, 0, 0.5, 6],
    [0, 0.5, 6, 0.5],
  ],
};

function drawTile(t: Ctx2D, name: string, ink: string, dpr: number): boolean {
  t.setTransform(dpr, 0, 0, dpr, 0, 0);
  t.clearRect(0, 0, TILE_CSS, TILE_CSS);
  t.strokeStyle = ink;
  t.fillStyle = ink;
  t.lineWidth = 1;
  if (name === 'dots') {
    t.beginPath();
    t.arc(3, 3, 1, 0, 2 * Math.PI);
    t.fill();
    return true;
  }
  if (name === 'checker') {
    t.fillRect(0, 0, 3, 3);
    t.fillRect(3, 3, 3, 3);
    return true;
  }
  const segs = STROKES[name];
  if (segs === undefined) return false;
  t.beginPath();
  for (const [x0, y0, x1, y1] of segs) {
    t.moveTo(x0, y0);
    t.lineTo(x1, y1);
  }
  t.stroke();
  return true;
}

export function patternTiles(
  createCanvas: () => HTMLCanvasElement,
  contextOf: (c: HTMLCanvasElement) => Ctx2D | null,
): PatternTiles {
  const tiles = new Map<string, HTMLCanvasElement | null>();
  const patterns = new WeakMap<Ctx2D, Map<string, CanvasPattern | null>>();
  const tileOf = (name: string, ink: string, dpr: number, key: string) => {
    if (tiles.has(key)) return tiles.get(key) ?? null;
    const c = createCanvas();
    const side = Math.max(1, Math.round(TILE_CSS * dpr));
    c.width = side;
    c.height = side;
    const t = contextOf(c);
    const tile = t !== null && drawTile(t, name, ink, side / TILE_CSS) ? c : null;
    tiles.set(key, tile);
    return tile;
  };
  return {
    get(ctx, name, ink, dpr) {
      if (name === HEALTH_PATTERN) return null;
      const key = `${name}|${ink}|${String(dpr)}`;
      let per = patterns.get(ctx);
      if (per === undefined) {
        per = new Map();
        patterns.set(ctx, per);
      }
      if (per.has(key)) return per.get(key) ?? null;
      const tile = tileOf(name, ink, dpr, key);
      const p = tile === null ? null : ctx.createPattern(tile, 'repeat');
      const side = tile?.width ?? TILE_CSS;
      // The tile is drawn at the DPR; the context draws in CSS px.
      p?.setTransform({ a: TILE_CSS / side, b: 0, c: 0, d: TILE_CSS / side, e: 0, f: 0 });
      per.set(key, p);
      return p;
    },
  };
}
