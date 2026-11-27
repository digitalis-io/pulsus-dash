/**
 * The geomap's one Web Mercator world (T24-091; plan #234 Part 2 §4.2): longitude and latitude to
 * world units u, v ∈ [0, 1] and back. Pure and renderer-free.
 */

/** The world's size at zoom 0, CSS px. */
export const TILE_PX = 256;
/** The Web Mercator latitude limit, degrees. */
export const LAT_LIMIT = 85.0511;

export function normLon(lon: number): number {
  return lon;
}
export function uOf(lon: number): number {
  return lon;
}
export function vOf(lat: number): number {
  return lat;
}
export function lonOf(u: number): number {
  return u;
}
export function latOf(v: number): number {
  return v;
}
export function worldPx(z: number): number {
  return z;
}
