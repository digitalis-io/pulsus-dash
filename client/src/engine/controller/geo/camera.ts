/**
 * The geomap camera (T24-091; plan #234 Part 2 §4.2): a centre in world units (u, v ∈ [0, 1]) and a
 * zoom, on a plot that is the whole canvas. The zoom range, the inset, containment (per axis inside
 * the world, else centred and letterboxed; never across ±180°), fit, anchored zoom, pans and the
 * bounds. Positions stay f64 world units; pixels exist only at paint and pick time. Pure and
 * renderer-free.
 */
import type { GeoBounds, GeoView } from '../../api';
import { LAT_LIMIT, latOf, lonOf, TILE_PX, uOf, vOf, worldPx } from './project';

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
/** The fit's zoom ceiling (raised to zMin on a large plot). */
const FIT_Z_MAX = 6;
/** The inset's ceiling, CSS px, and its share of the plot's shorter side. */
const INSET_MAX = 48;
const INSET_SHARE = 0.1;
/** The view of a fit with no shown row. */
const EMPTY_LAT = 20;
const EMPTY_LON = 0;

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/** zMin = clamp(log2(max(W, H)/256), 0, 14); zMax 14. */
export function zoomRange(w: number, h: number): { zMin: number; zMax: number } {
  const z = Math.log2(Math.max(w, h) / TILE_PX);
  return { zMin: Number.isFinite(z) ? clamp(z, 0, Z_MAX) : 0, zMax: Z_MAX };
}

/** p = min(48, 10 % of min(W, H)) CSS px. */
export function insetOf(w: number, h: number): number {
  return Math.min(INSET_MAX, INSET_SHARE * Math.min(w, h));
}

export function camOf(v: GeoView): Cam {
  return { u: uOf(v.lon), v: vOf(v.lat), z: v.zoom };
}

export function viewOf(c: Cam): GeoView {
  return { lat: latOf(c.v), lon: lonOf(c.u), zoom: c.z };
}

/** One axis: inside the world (a value already inside is kept bit for bit), else centred. */
function containAxis(pos: number, world: number, plot: number): number {
  if (world < plot) return 0.5;
  const p = pos * world;
  const lo = plot / 2;
  const hi = world - plot / 2;
  return p < lo ? lo / world : p > hi ? hi / world : pos;
}

/** The zoom raised to zMin (and at most 14), then each axis contained. */
export function contain(c: Cam, w: number, h: number): Cam {
  const { zMin, zMax } = zoomRange(w, h);
  const z = Number.isFinite(c.z) ? clamp(c.z, zMin, zMax) : zMin;
  const S = worldPx(z);
  const u = containAxis(Number.isFinite(c.u) ? c.u : 0.5, S, w);
  const v = containAxis(Number.isFinite(c.v) ? c.v : 0.5, S, h);
  return u === c.u && v === c.v && z === c.z ? c : { u, v, z };
}

/**
 * The fit of `pts` with the inset: z = the smaller of the axes' log2((plot − 2p)/(span·256)),
 * clamped to [zMin, `zCap`] (default max(6, zMin)), about the box's centre, then contained; no point
 * → (20, 0, zMin).
 */
export function fitView(pts: readonly WorldPoint[], w: number, h: number, zCap?: number): Cam {
  const { zMin } = zoomRange(w, h);
  if (pts.length === 0) return contain({ u: uOf(EMPTY_LON), v: vOf(EMPTY_LAT), z: zMin }, w, h);
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (const p of pts) {
    if (p.u < u0) u0 = p.u;
    if (p.u > u1) u1 = p.u;
    if (p.v < v0) v0 = p.v;
    if (p.v > v1) v1 = p.v;
  }
  const p = insetOf(w, h);
  const zx = Math.log2((w - 2 * p) / ((u1 - u0) * TILE_PX));
  const zy = Math.log2((h - 2 * p) / ((v1 - v0) * TILE_PX));
  const fitted = Math.min(zx, zy);
  const hi = zCap ?? Math.max(FIT_Z_MAX, zMin);
  const z = Number.isNaN(fitted) ? zMin : clamp(fitted, zMin, Math.max(zMin, hi));
  return contain({ u: (u0 + u1) / 2, v: (v0 + v1) / 2, z }, w, h);
}

/** The box a–b fitted exactly (no inset), z ≤ 14, then contained (a right-drag box). */
export function fitBox(a: WorldPoint, b: WorldPoint, w: number, h: number): Cam {
  const su = Math.abs(b.u - a.u);
  const sv = Math.abs(b.v - a.v);
  const S = Math.min(w / su, h / sv);
  const z = Math.min(Z_MAX, Math.log2(S / TILE_PX));
  return contain({ u: (a.u + b.u) / 2, v: (a.v + b.v) / 2, z }, w, h);
}

/** Zooms by `dz` keeping the world point under (x, y) under it, then contains (INT-002). */
export function zoomAbout(c: Cam, dz: number, x: number, y: number, w: number, h: number): Cam {
  const S = worldPx(c.z);
  const au = c.u + (x - w / 2) / S;
  const av = c.v + (y - h / 2) / S;
  const { zMin, zMax } = zoomRange(w, h);
  const z = clamp(c.z + dz, zMin, zMax);
  const S2 = worldPx(z);
  return contain({ u: au - (x - w / 2) / S2, v: av - (y - h / 2) / S2, z }, w, h);
}

/** Moves the centre by (dx, dy) CSS px, then contains. */
export function panPx(c: Cam, dx: number, dy: number, w: number, h: number): Cam {
  const S = worldPx(c.z);
  return contain({ u: c.u + dx / S, v: c.v + dy / S, z: c.z }, w, h);
}

/** The plot edges' degrees, clamped to [−180, 180] and ±85.0511; never wrapped. */
export function boundsOf(c: Cam, w: number, h: number): GeoBounds {
  const S = worldPx(c.z);
  const lon = (u: number) => clamp(lonOf(u), -180, 180);
  const lat = (v: number) => clamp(latOf(v), -LAT_LIMIT, LAT_LIMIT);
  return {
    west: lon(c.u - w / 2 / S),
    south: lat(c.v + h / 2 / S),
    east: lon(c.u + w / 2 / S),
    north: lat(c.v - h / 2 / S),
  };
}

/** World (u, v) to CSS px of the plot. */
export function toPx(c: Cam, u: number, v: number, w: number, h: number): { x: number; y: number } {
  const S = worldPx(c.z);
  return { x: w / 2 + (u - c.u) * S, y: h / 2 + (v - c.v) * S };
}

/** CSS px of the plot to world (u, v). */
export function fromPx(c: Cam, x: number, y: number, w: number, h: number): WorldPoint {
  const S = worldPx(c.z);
  return { u: c.u + (x - w / 2) / S, v: c.v + (y - h / 2) / S };
}

/** Two cameras equal as views within `eps` (lat, lon and zoom). */
export function sameView(a: Cam, b: Cam, eps = 1e-9): boolean {
  const x = viewOf(a);
  const y = viewOf(b);
  return (
    Math.abs(x.lat - y.lat) <= eps &&
    Math.abs(x.lon - y.lon) <= eps &&
    Math.abs(x.zoom - y.zoom) <= eps
  );
}
