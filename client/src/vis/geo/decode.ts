// stub (#231 tests first)
import type { Basemap, Gazetteer } from './types';
export function decodeBasemap(j: unknown): Basemap | null {
  void j;
  return { countries: [], coast: [], border: [] };
}
export function decodeGazetteer(j: unknown): Gazetteer | null {
  void j;
  const m = new Map<string, never[]>();
  return {
    country: [],
    region: [],
    iata: [],
    cloud: [],
    countryByA2: m,
    countryByA3: m,
    countryByName: m,
    regionByCode: m,
    iataByCode: m,
    cloudById: m,
  };
}
