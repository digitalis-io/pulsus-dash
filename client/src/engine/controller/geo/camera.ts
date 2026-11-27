/**
 * The geomap camera (T24-091; plan #234 Part 2 §4.2): a centre in world units and a zoom; the zoom
 * range, the inset, containment, fit, anchored zoom, pans and bounds. Pure and renderer-free.
 */
import type { GeoBounds, GeoView } from '../../api';

/** A camera: the centre in world units and the zoom. */
export interface Cam {
  readonly u: number;
  readonly v: number;
  readonly z: number;
}

export interface WorldPoint {
  readonly u: number;
  readonly v: number;
}

export const Z_MAX = 14;

export function zoomRange(w: number, h: number): { zMin: number; zMax: number } {
  void w;
  void h;
  return { zMin: NaN, zMax: NaN };
}
export function insetOf(w: number, h: number): number {
  void w;
  void h;
  return NaN;
}
export function camOf(v: GeoView): Cam {
  return { u: v.lon, v: v.lat, z: v.zoom };
}
export function viewOf(c: Cam): GeoView {
  return { lat: c.v, lon: c.u, zoom: c.z };
}
export function contain(c: Cam, w: number, h: number): Cam {
  void w;
  void h;
  return c;
}
export function fitView(
  pts: readonly WorldPoint[],
  w: number,
  h: number,
  zCap?: number,
): Cam {
  void pts;
  void w;
  void h;
  void zCap;
  return { u: 0, v: 0, z: 0 };
}
export function fitBox(a: WorldPoint, b: WorldPoint, w: number, h: number): Cam {
  void a;
  void b;
  void w;
  void h;
  return { u: 0, v: 0, z: 0 };
}
export function zoomAbout(c: Cam, dz: number, x: number, y: number, w: number, h: number): Cam {
  void dz;
  void x;
  void y;
  void w;
  void h;
  return c;
}
export function panPx(c: Cam, dx: number, dy: number, w: number, h: number): Cam {
  void dx;
  void dy;
  void w;
  void h;
  return c;
}
export function boundsOf(c: Cam, w: number, h: number): GeoBounds {
  void c;
  void w;
  void h;
  return { west: 0, south: 0, east: 0, north: 0 };
}
export function toPx(c: Cam, u: number, v: number, w: number, h: number): { x: number; y: number } {
  void c;
  void w;
  void h;
  return { x: u, y: v };
}
export function fromPx(c: Cam, x: number, y: number, w: number, h: number): WorldPoint {
  void c;
  void w;
  void h;
  return { u: x, v: y };
}
