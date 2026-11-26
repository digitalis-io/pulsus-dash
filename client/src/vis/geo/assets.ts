// stub (#231 tests first)
import type { GeoData } from './types';
export { decodeBasemap, decodeGazetteer } from './decode';
export function geoLoader(
  get: (url: string, init: RequestInit) => Promise<Response>,
  urls: { readonly basemap: string; readonly gazetteer: string },
): () => Promise<GeoData> {
  void get;
  void urls;
  return () => Promise.resolve({ basemap: null, gazetteer: null });
}
export const loadGeoData: () => Promise<GeoData> = () =>
  Promise.resolve({ basemap: null, gazetteer: null });
