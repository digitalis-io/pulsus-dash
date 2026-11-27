/**
 * The geomap's pick (T24-091; plan #234 Part 2 §4.6): the last mark in draw order whose disc of
 * radius max(r + 4, 12) holds the point, and the marks whose centres a band holds. Pure and
 * renderer-free.
 */
import type { PlotRect } from '../../api';
import { toPx, type Cam } from './camera';
import type { LaidMark, Placed } from './marks';

/** The pick disc: r + 4, at least 12 CSS px. */
export const PICK_PAD = 4;
export const PICK_MIN = 12;

/** `marks` with their centres under `cam` on a `w` × `h` plot. */
export function placeMarks(marks: readonly LaidMark[], cam: Cam, w: number, h: number): Placed {
  const x = new Float64Array(marks.length);
  const y = new Float64Array(marks.length);
  placeInto(marks, cam, w, h, x, y);
  return { marks, x, y };
}

/** Writes the centres of `marks` into `x` and `y` (no allocation; per frame). */
export function placeInto(
  marks: readonly LaidMark[],
  cam: Cam,
  w: number,
  h: number,
  x: Float64Array,
  y: Float64Array,
): void {
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i];
    if (m === undefined) continue;
    const p = toPx(cam, m.u, m.v, w, h);
    x[i] = p.x;
    y[i] = p.y;
  }
}

/** The last mark of `p` (draw order) under (x, y), or null. */
export function pickMark(p: Placed, x: number, y: number): LaidMark | null {
  for (let i = p.marks.length - 1; i >= 0; i--) {
    const m = p.marks[i];
    if (m === undefined) continue;
    const r = Math.max(m.r + PICK_PAD, PICK_MIN);
    const dx = x - (p.x[i] ?? NaN);
    const dy = y - (p.y[i] ?? NaN);
    if (dx * dx + dy * dy <= r * r) return m;
  }
  return null;
}

/** The sorted row keys of the marks whose centres lie inside `box` (edges included). */
export function marksInBox(p: Placed, box: PlotRect): string[] {
  const keys: string[] = [];
  for (let i = 0; i < p.marks.length; i++) {
    const cx = p.x[i] ?? NaN;
    const cy = p.y[i] ?? NaN;
    if (cx < box.x || cx > box.x + box.width || cy < box.y || cy > box.y + box.height) continue;
    keys.push(...(p.marks[i]?.keys ?? []));
  }
  return keys.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
