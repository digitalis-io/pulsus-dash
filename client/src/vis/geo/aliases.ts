// stub (#231 tests first)
export function normKey(k: string): string {
  return k;
}
export const LAT_ALIASES: readonly string[] = [];
export const LON_ALIASES: readonly string[] = [];
export const HINT_KEY = 'cloud_provider';
export type AutoKind =
  'coords' | 'geohash' | 'cloud' | 'region' | 'country' | 'iata' | 'regionOrCloud';
export const GEO_AUTO_RULES: readonly {
  readonly rule: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  readonly kind: AutoKind;
  readonly aliases: readonly string[];
}[] = [];
export const GEO_ALIAS_KEYS: ReadonlySet<string> = new Set();
