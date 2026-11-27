/**
 * The geomap's pick (T24-091; plan #234 Part 2 §4.6): the last mark in draw order under a point,
 * and the marks whose centres a band holds. Pure and renderer-free.
 */
import type { PlotRect } from '../../api';
import type { Cam } from './camera';
import type { LaidMark, Placed } from './marks';

/** `marks` with their centres under `cam` on a `w` × `h` plot. */
export function placeMarks(marks: readonly LaidMark[], cam: Cam, w: number, h: number): Placed {
  void cam;
  void w;
  void h;
  return { marks, x: new Float64Array(marks.length), y: new Float64Array(marks.length) };
}

export function pickMark(p: Placed, x: number, y: number): LaidMark | null {
  void p;
  void x;
  void y;
  return null;
}
export function marksInBox(p: Placed, box: PlotRect): string[] {
  void p;
  void box;
  return [];
}
