/**
 * The geo assets' loader (T24-087, T24 §5.11; plan #231 §4.2): both files fetched from the same
 * origin once per page, in parallel, each validated whole. The promise never rejects: an asset
 * whose GET fails, whose body is not JSON or that does not validate is null, with one
 * `console.debug` line naming the file; the other asset is unaffected. There is no retry and no
 * cancellation (the request is shared): a failed asset stays null until the page reloads (T24 §9).
 */
import { decodeBasemap, decodeGazetteer } from './decode';
import type { GeoData } from './types';
import { basemapUrl, gazetteerUrl } from './urls';

export { decodeBasemap, decodeGazetteer } from './decode';

type Get = (url: string, init: RequestInit) => Promise<Response>;

async function one<T>(
  get: Get,
  url: string,
  file: string,
  decode: (j: unknown) => T | null,
): Promise<T | null> {
  let value: T | null = null;
  try {
    const res = await get(url, { cache: 'force-cache' });
    if (res.ok) value = decode((await res.json()) as unknown);
  } catch {
    value = null;
  }
  if (value === null) console.debug(`geo-data: ${file} unavailable`);
  return value;
}

/** A loader over `get`: its first call starts both GETs; every call returns that one promise. */
export function geoLoader(
  get: Get,
  urls: { readonly basemap: string; readonly gazetteer: string },
): () => Promise<GeoData> {
  let shared: Promise<GeoData> | null = null;
  return () => {
    shared ??= Promise.all([
      one(get, urls.basemap, 'basemap.json', decodeBasemap),
      one(get, urls.gazetteer, 'gazetteer.json', decodeGazetteer),
    ]).then(([basemap, gazetteer]) => Object.freeze({ basemap, gazetteer }));
    return shared;
  };
}

/** The page's loader of the bundled assets (`urls.ts`); E2 imports it lazily. */
export const loadGeoData: () => Promise<GeoData> = geoLoader((u, i) => fetch(u, i), {
  basemap: basemapUrl,
  gazetteer: gazetteerUrl,
});
