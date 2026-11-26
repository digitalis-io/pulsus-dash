/**
 * Geomap label aliases (T24 §4.10, T24-080, T24-081): the normal form of a label key and the auto
 * rules in precedence order. No imports: E3b's `hasGeoFields` reads `GEO_ALIAS_KEYS`.
 */

/** The normal form of a label key: ASCII capitals lower-cased and `.` read as `_`; nothing else changes. */
export function normKey(k: string): string {
  return k.replace(/[A-Z.]/g, (c) => (c === '.' ? '_' : c.toLowerCase()));
}

export const LAT_ALIASES: readonly string[] = Object.freeze([
  'lat',
  'latitude',
  'geo_location_lat',
]);
export const LON_ALIASES: readonly string[] = Object.freeze([
  'lon',
  'lng',
  'longitude',
  'geo_location_lon',
]);
/** The provider hint of the cloud rules (3 and 7). */
export const HINT_KEY = 'cloud_provider';

export type AutoKind =
  'coords' | 'geohash' | 'cloud' | 'region' | 'country' | 'iata' | 'regionOrCloud';

/** §4.10, row by row: within a rule the aliases are in precedence order. */
export const GEO_AUTO_RULES: readonly {
  readonly rule: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  readonly kind: AutoKind;
  readonly aliases: readonly string[];
}[] = Object.freeze(
  (
    [
      [1, 'coords', [...LAT_ALIASES, ...LON_ALIASES]],
      [2, 'geohash', ['geohash', 'geo_hash']],
      [3, 'cloud', ['cloud_region']],
      [4, 'region', ['geo_region_iso_code', 'region_iso_code']],
      [5, 'country', ['geo_country_iso_code', 'country_code', 'country']],
      [6, 'iata', ['iata', 'iata_code', 'airport']],
      [7, 'regionOrCloud', ['region']],
    ] as const
  ).map(([rule, kind, aliases]) =>
    Object.freeze({ rule, kind, aliases: Object.freeze([...aliases]) }),
  ),
);

/** Every alias of rules 1–7 (not the hint). */
export const GEO_ALIAS_KEYS: ReadonlySet<string> = new Set(
  GEO_AUTO_RULES.flatMap((r) => r.aliases),
);
