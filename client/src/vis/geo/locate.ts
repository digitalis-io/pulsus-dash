/**
 * Location resolution (T24-080 to T24-084; plan #231 §4.1): a series' labels → a place on the map
 * or the reason there is none. Pure, total and deterministic: it never throws, reads only its
 * arguments, and returns a fresh, deeply frozen result.
 */
import type { Labels } from '../../data/frames';
import {
  GEO_AUTO_RULES,
  HINT_KEY,
  LAT_ALIASES,
  LON_ALIASES,
  normKey,
  type AutoKind,
} from './aliases';
import { decodeGeohash } from './geohash';
import type { CloudRow, CodeRow, CountryRow, Gazetteer } from './types';

export { decodeGeohash } from './geohash';

export type GeoSource = 'coords' | 'geohash' | 'country' | 'region' | 'iata' | 'cloud';

export interface GeoPlace {
  readonly lat: number;
  readonly lon: number;
  readonly source: GeoSource;
  /** The raw label key of the first present alias (for coordinates, the latitude's). */
  readonly key: string;
  /** Canonical: the alpha-2 code, the region or IATA code, the cloud id, the geohash; null for coordinates. */
  readonly code: string | null;
  readonly provider: string | null;
  readonly name: string | null;
  /** The geohash cell's height and width in degrees; null otherwise. */
  readonly cell: { readonly dLat: number; readonly dLon: number } | null;
}

export type LocationResult =
  | { readonly status: 'placed'; readonly place: GeoPlace }
  | { readonly status: 'noLocation' }
  | { readonly status: 'gazetteerUnavailable' }
  | {
      readonly status: 'invalid';
      readonly reason: 'coords' | 'incompleteCoords' | 'geohash';
      readonly key: string;
    }
  | {
      readonly status: 'unknownCode';
      readonly source: GeoSource;
      readonly key: string;
      readonly value: string;
    }
  | {
      readonly status: 'providerMismatch';
      readonly key: string;
      /** The hint, lower-cased. */
      readonly provider: string;
      readonly candidates: readonly string[];
    }
  | {
      readonly status: 'ambiguous';
      readonly reason:
        'keyCollision' | 'aliasConflict' | 'sharedCode' | 'name' | 'providers' | 'regionOrCloud';
      readonly candidates: readonly string[];
    };

export type LocationOption =
  | { readonly mode: 'auto' }
  | { readonly mode: 'coords'; readonly lat: string; readonly lon: string }
  | { readonly mode: 'geohash'; readonly field: string }
  | {
      readonly mode: 'lookup';
      readonly field: string;
      readonly gazetteer: 'country' | 'region' | 'iata' | 'cloud';
      /** `[A-Z]{2}`, region only: prefixes a value without `-`. */
      readonly country?: string;
    };

/** Normal-form key → its present (non-empty) raw entries, raw keys in UTF-16 order. */
type Index = ReadonlyMap<string, readonly (readonly [raw: string, value: string])[]>;
type Lookup = 'country' | 'region' | 'iata' | 'cloud' | 'regionOrCloud';

const COORD = /^-?\d{1,3}(\.\d{1,12})?$/;
const GEOHASH = /^[0-9b-hjkmnp-z]{1,12}$/;
const COUNTRY_A2 = /^[A-Za-z]{2}$/;
const COUNTRY_A3 = /^[A-Za-z]{3}$/;
const LAT_SET = new Set(LAT_ALIASES);
const LON_SET = new Set(LON_ALIASES);

/** Freezes a result and every object in it. */
function done(r: LocationResult): LocationResult {
  if (r.status === 'placed') {
    if (r.place.cell !== null) Object.freeze(r.place.cell);
    Object.freeze(r.place);
  }
  if ('candidates' in r) Object.freeze(r.candidates);
  return Object.freeze(r);
}

function index(labels: Labels): Index {
  const m = new Map<string, [string, string][]>();
  for (const raw of Object.keys(labels).sort()) {
    const value = labels[raw];
    if (typeof value !== 'string' || value === '') continue;
    const k = normKey(raw);
    const v = m.get(k);
    if (v === undefined) m.set(k, [[raw, value]]);
    else v.push([raw, value]);
  }
  return m;
}

/** The first present entry of a normal-form key (its raw key names a merged key, L9). */
function first(m: Index, k: string): readonly [string, string] | undefined {
  return m.get(k)?.[0];
}

const pairs = (xs: readonly (readonly [string, string])[]): string[] =>
  xs.map(([k, v]) => `${k}=${v}`).sort();

/** T24-081 (a): two raw keys of one read normal form with different values. */
function collision(m: Index, keys: readonly string[]): LocationResult | null {
  for (const k of keys) {
    const vs = m.get(k) ?? [];
    if (new Set(vs.map(([, v]) => v)).size > 1) {
      return { status: 'ambiguous', reason: 'keyCollision', candidates: pairs(vs) };
    }
  }
  return null;
}

/** T24-082 and plan §4.1 step 4a: validity of every present alias first, then the per-axis conflict. */
function coords(m: Index, lat: readonly string[], lon: readonly string[]): LocationResult {
  const la = lat.flatMap((k) => m.get(k)?.slice(0, 1) ?? []);
  const lo = lon.flatMap((k) => m.get(k)?.slice(0, 1) ?? []);
  if (la.length === 0 && lo.length === 0) return { status: 'noLocation' };
  const any = la[0] ?? lo[0];
  if (la.length === 0 || lo.length === 0) {
    return { status: 'invalid', reason: 'incompleteCoords', key: any?.[0] ?? '' };
  }
  for (const [axis, limit] of [
    [la, 90],
    [lo, 180],
  ] as const) {
    for (const [raw, v] of axis) {
      if (!COORD.test(v) || Math.abs(Number(v)) > limit) {
        return { status: 'invalid', reason: 'coords', key: raw };
      }
    }
  }
  for (const axis of [la, lo]) {
    if (new Set(axis.map(([, v]) => Number(v))).size > 1) {
      return { status: 'ambiguous', reason: 'aliasConflict', candidates: pairs(axis) };
    }
  }
  const [latKey, latV] = la[0] ?? ['', '0'];
  const lonV = lo[0]?.[1] ?? '0';
  return {
    status: 'placed',
    place: {
      lat: Number(latV) + 0,
      lon: Number(lonV) + 0,
      source: 'coords',
      key: latKey,
      code: null,
      provider: null,
      name: null,
      cell: null,
    },
  };
}

/** T24-083: the first invalid alias, then a conflict of the lower-cased hashes, then the cell. */
function geohash(m: Index, keys: readonly string[]): LocationResult {
  const got = keys.flatMap((k) => m.get(k)?.slice(0, 1) ?? []);
  for (const [raw, v] of got) {
    if (!GEOHASH.test(v.toLowerCase())) return { status: 'invalid', reason: 'geohash', key: raw };
  }
  if (new Set(got.map(([, v]) => v.toLowerCase())).size > 1) {
    return { status: 'ambiguous', reason: 'aliasConflict', candidates: pairs(got) };
  }
  const [raw, v] = got[0] ?? ['', ''];
  const h = v.toLowerCase();
  const c = decodeGeohash(h);
  if (c === null) return { status: 'invalid', reason: 'geohash', key: raw };
  return {
    status: 'placed',
    place: {
      lat: c.lat,
      lon: c.lon,
      source: 'geohash',
      key: raw,
      code: h,
      provider: null,
      name: null,
      cell: { dLat: c.dLat, dLon: c.dLon },
    },
  };
}

/** A gazetteer hit: its candidate label, the place it gives and its row (the row identity). */
interface Hit {
  readonly label: string;
  readonly row: CountryRow | CodeRow | CloudRow;
  readonly place: (key: string) => GeoPlace;
}

function at(
  source: GeoSource,
  code: string,
  provider: string | null,
  name: string,
  x: number,
  y: number,
): (key: string) => GeoPlace {
  return (key) => ({ lat: y / 100, lon: x / 100, source, key, code, provider, name, cell: null });
}

const cloudHits = (g: Gazetteer, v: string): Hit[] =>
  (g.cloudById.get(v.toLowerCase()) ?? []).map((r) => ({
    label: `${r.provider} ${r.id}`,
    row: r,
    place: at('cloud', r.id, r.provider, r.place, r.x, r.y),
  }));

const codeHits = (rows: readonly CodeRow[] | undefined, source: GeoSource): Hit[] =>
  (rows ?? []).map((r) => ({
    label: `${r.code} ${r.name}`,
    row: r,
    place: at(source, r.code, null, r.name, r.x, r.y),
  }));

const countryHits = (rows: readonly CountryRow[] | undefined): Hit[] =>
  (rows ?? []).map((r) => ({
    label: `${r.a2} ${r.name}`,
    row: r,
    place: at('country', r.a2, null, r.name, r.x, r.y),
  }));

/** One alias (T24-084, T24-081 (c), (d)): unknown → hint → several → one. */
function lookup(
  kind: Lookup,
  key: string,
  v: string,
  hint: string | null,
  g: Gazetteer,
): { result: LocationResult; row: Hit['row'] | null } {
  const none = (result: LocationResult) => ({ result, row: null });
  const filter = (c: Hit[]): Hit[] | null => {
    if (hint === null) return c;
    const p = hint.toLowerCase();
    const h = c.filter((x) => (x.row as CloudRow).provider === p);
    return h.length === 0 ? null : h;
  };
  const mismatch = (c: Hit[]): LocationResult => ({
    status: 'providerMismatch',
    key,
    provider: (hint ?? '').toLowerCase(),
    candidates: c.map((x) => x.label).sort(),
  });
  let hits: Hit[];
  let several: 'sharedCode' | 'name' | 'providers' | 'regionOrCloud';
  if (kind === 'regionOrCloud') {
    const c = cloudHits(g, v);
    const r = codeHits(g.regionByCode.get(v.toUpperCase()), 'region');
    if (c.length === 0 && r.length === 0) {
      return none({ status: 'unknownCode', source: 'cloud', key, value: v });
    }
    const ch = c.length === 0 ? c : filter(c);
    if (ch === null && r.length === 0) return none(mismatch(c));
    hits = [...(ch ?? []), ...r];
    several =
      (ch ?? []).length > 0 && r.length > 0
        ? 'regionOrCloud'
        : r.length > 0
          ? 'sharedCode'
          : 'providers';
  } else {
    if (kind === 'cloud') {
      hits = cloudHits(g, v);
      several = 'providers';
    } else if (kind === 'region') {
      hits = codeHits(g.regionByCode.get(v.toUpperCase()), 'region');
      several = 'sharedCode';
    } else if (kind === 'iata') {
      hits = codeHits(g.iataByCode.get(v.toUpperCase()), 'iata');
      several = 'sharedCode';
    } else if (COUNTRY_A2.test(v)) {
      hits = countryHits(g.countryByA2.get(v.toUpperCase()));
      several = 'sharedCode';
    } else if (COUNTRY_A3.test(v)) {
      hits = countryHits(g.countryByA3.get(v.toUpperCase()));
      several = 'sharedCode';
    } else {
      hits = countryHits(g.countryByName.get(v.normalize('NFC').toLowerCase()));
      several = 'name';
    }
    if (hits.length === 0) return none({ status: 'unknownCode', source: kind, key, value: v });
    if (kind === 'cloud') {
      const h = filter(hits);
      if (h === null) return none(mismatch(hits));
      hits = h;
    }
  }
  const [one, ...more] = hits;
  if (one === undefined) return none({ status: 'unknownCode', source: 'cloud', key, value: v });
  if (more.length > 0) {
    return none({
      status: 'ambiguous',
      reason: several,
      candidates: hits.map((x) => x.label).sort(),
    });
  }
  return { result: { status: 'placed', place: one.place(key) }, row: one.row };
}

/** Rules 3–7 (T24-081 (c)): each present alias in precedence order; aliases placing different rows conflict. */
function aliasRule(
  kind: Lookup,
  keys: readonly string[],
  m: Index,
  g: Gazetteer | null,
): LocationResult {
  if (g === null) return { status: 'gazetteerUnavailable' };
  const hint =
    kind === 'cloud' || kind === 'regionOrCloud' ? (first(m, HINT_KEY)?.[1] ?? null) : null;
  const placed: { pair: readonly [string, string]; result: LocationResult; row: Hit['row'] }[] = [];
  for (const k of keys) {
    const e = first(m, k);
    if (e === undefined) continue;
    const r = lookup(kind, e[0], e[1], hint, g);
    if (r.row === null) return r.result;
    placed.push({ pair: e, result: r.result, row: r.row });
  }
  const [head] = placed;
  if (head === undefined) return { status: 'noLocation' };
  if (placed.some((p) => p.row !== head.row)) {
    return {
      status: 'ambiguous',
      reason: 'aliasConflict',
      candidates: pairs(placed.map((p) => p.pair)),
    };
  }
  return head.result;
}

const LOOKUP_KIND: Readonly<Record<Exclude<AutoKind, 'coords' | 'geohash'>, Lookup>> = {
  cloud: 'cloud',
  region: 'region',
  country: 'country',
  iata: 'iata',
  regionOrCloud: 'regionOrCloud',
};

function explicit(
  m: Index,
  o: Exclude<LocationOption, { mode: 'auto' }>,
  g: Gazetteer | null,
): LocationResult {
  if (o.mode === 'coords') {
    const lat = [normKey(o.lat)];
    const lon = [normKey(o.lon)];
    return (
      collision(m, [...lat, ...lon]) ??
      coords(
        m,
        lat.filter((k) => m.has(k)),
        lon.filter((k) => m.has(k)),
      )
    );
  }
  const k = normKey(o.field);
  const reads = o.mode === 'lookup' && o.gazetteer === 'cloud' ? [k, HINT_KEY] : [k];
  const c = collision(m, reads);
  if (c !== null) return c;
  const e = first(m, k);
  if (e === undefined) return { status: 'noLocation' };
  if (o.mode === 'geohash') return geohash(m, [k]);
  if (g === null) return { status: 'gazetteerUnavailable' };
  let v = e[1];
  if (o.gazetteer === 'region' && o.country !== undefined && o.country !== '' && !v.includes('-')) {
    v = `${o.country}-${v}`;
  }
  const hint = o.gazetteer === 'cloud' ? (first(m, HINT_KEY)?.[1] ?? null) : null;
  return lookup(o.gazetteer, e[0], v, hint, g).result;
}

function auto(m: Index, g: Gazetteer | null): LocationResult {
  for (const rule of GEO_AUTO_RULES) {
    const present = rule.aliases.filter((k) => m.has(k));
    if (present.length === 0) continue;
    const hinted = rule.kind === 'cloud' || rule.kind === 'regionOrCloud';
    const c = collision(m, hinted ? [...rule.aliases, HINT_KEY] : rule.aliases);
    if (c !== null) return c;
    if (rule.kind === 'coords') {
      return coords(
        m,
        present.filter((k) => LAT_SET.has(k)),
        present.filter((k) => LON_SET.has(k)),
      );
    }
    if (rule.kind === 'geohash') return geohash(m, present);
    return aliasRule(LOOKUP_KIND[rule.kind], present, m, g);
  }
  return { status: 'noLocation' };
}

/** Resolves one series' labels (T24 §5.11). `g` null: lookups are `gazetteerUnavailable`. */
export function locate(labels: Labels, o: LocationOption, g: Gazetteer | null): LocationResult {
  const m = index(labels);
  return done(o.mode === 'auto' ? auto(m, g) : explicit(m, o, g));
}
