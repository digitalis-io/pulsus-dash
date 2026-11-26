/** Geohash decoding (T24-083). No imports. */

const B32 = '0123456789bcdefghjkmnpqrstuvwxyz';
const GEOHASH = /^[0-9b-hjkmnp-z]{1,12}$/;

/**
 * The centre of the cell of a lower-case geohash of 1–12 characters and the cell's height (`dLat`)
 * and width (`dLon`) in degrees; null for any other string.
 */
export function decodeGeohash(
  h: string,
): { lat: number; lon: number; dLat: number; dLon: number } | null {
  if (!GEOHASH.test(h)) return null;
  let lat0 = -90;
  let lat1 = 90;
  let lon0 = -180;
  let lon1 = 180;
  let even = true;
  for (const c of h) {
    const i = B32.indexOf(c);
    for (const bit of [16, 8, 4, 2, 1]) {
      if (even) {
        const mid = (lon0 + lon1) / 2;
        if (i & bit) lon0 = mid;
        else lon1 = mid;
      } else {
        const mid = (lat0 + lat1) / 2;
        if (i & bit) lat0 = mid;
        else lat1 = mid;
      }
      even = !even;
    }
  }
  return { lat: (lat0 + lat1) / 2, lon: (lon0 + lon1) / 2, dLat: lat1 - lat0, dLon: lon1 - lon0 };
}
