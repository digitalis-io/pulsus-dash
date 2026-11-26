/**
 * The decoded geo assets (T24 §5.11, §5.12; plan #231 §3.2). Coordinates are integers in hundredths
 * of a degree (x = lon · 100, y = lat · 100); rings and polylines are absolute interleaved
 * `[x0, y0, x1, y1, …]`, and a ring is implicitly closed.
 */

/** One basemap country: its polygons, each `[outer, ...holes]`. */
export interface BasemapCountry {
  readonly a2: string;
  readonly a3: string;
  readonly name: string;
  readonly polygons: readonly (readonly Int32Array[])[];
}

/** `basemap.json`, decoded: the countries, the coast and the shared-border polylines. */
export interface Basemap {
  readonly countries: readonly BasemapCountry[];
  readonly coast: readonly Int32Array[];
  readonly border: readonly Int32Array[];
}

/** An ISO 3166-1 row: its label point. */
export interface CountryRow {
  readonly a2: string;
  readonly a3: string;
  readonly name: string;
  readonly x: number;
  readonly y: number;
}

/** An ISO 3166-2 region or an IATA airport (`name` is the airport's place). */
export interface CodeRow {
  readonly code: string;
  readonly name: string;
  readonly x: number;
  readonly y: number;
}

/** A cloud region of one provider at its published place. */
export interface CloudRow {
  readonly provider: string;
  readonly id: string;
  readonly place: string;
  readonly x: number;
  readonly y: number;
}

type Idx<R> = ReadonlyMap<string, readonly R[]>;

/** `gazetteer.json`, decoded: the rows in file order and their indexes (values in file order). */
export interface Gazetteer {
  readonly country: readonly CountryRow[];
  readonly region: readonly CodeRow[];
  readonly iata: readonly CodeRow[];
  readonly cloud: readonly CloudRow[];
  readonly countryByA2: Idx<CountryRow>;
  readonly countryByA3: Idx<CountryRow>;
  /** Keyed by the name after NFC normalisation and `toLowerCase`. */
  readonly countryByName: Idx<CountryRow>;
  readonly regionByCode: Idx<CodeRow>;
  readonly iataByCode: Idx<CodeRow>;
  readonly cloudById: Idx<CloudRow>;
}

/** What `loadGeoData` resolves to: an asset that failed to load or validate is null (T24-087). */
export interface GeoData {
  readonly basemap: Basemap | null;
  readonly gazetteer: Gazetteer | null;
}
