/**
 * The geomap's one Web Mercator world (T24-091; plan #234 Part 2 §4.2): longitude and latitude to
 * world units u, v ∈ [0, 1] and back, and the world's size in CSS px at a zoom. No repeat across
 * ±180°. Pure and renderer-free.
 */

/** The world's size at zoom 0, CSS px. */
export const TILE_PX = 256;
/** The Web Mercator latitude limit, degrees. */
export const LAT_LIMIT = 85.0511;

/** A longitude in [−180, 180): ((lon + 180) mod 360 + 360) mod 360 − 180. */
export function normLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/** u = (lon + 180)/360 of the normalised longitude. */
export function uOf(lon: number): number {
  return (normLon(lon) + 180) / 360;
}

/** v = ½ − ln((1 + sin φ)/(1 − sin φ))/(4π). */
export function vOf(lat: number): number {
  const s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

/** lon = 360u − 180. */
export function lonOf(u: number): number {
  return 360 * u - 180;
}

/** lat = atan(sinh(π(1 − 2v))). */
export function latOf(v: number): number {
  return (Math.atan(Math.sinh(Math.PI * (1 - 2 * v))) * 180) / Math.PI;
}

/** The world's width and height at zoom `z`: 256·2^z CSS px. */
export function worldPx(z: number): number {
  return TILE_PX * 2 ** z;
}
