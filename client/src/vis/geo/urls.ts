/**
 * The content-hashed URLs of the bundled geo assets (T24-087; plan #231 §3.2). This module is the
 * `geo-assets` build input (`vite.config.ts`), so Vite emits both files and the signed asset
 * manifest lists them while no route imports them yet; it holds only these two strings, so it
 * shares no code with the index chunk.
 */
import basemap from './data/basemap.json?url';
import gazetteer from './data/gazetteer.json?url';

export const basemapUrl: string = basemap;
export const gazetteerUrl: string = gazetteer;
