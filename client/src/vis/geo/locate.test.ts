/**
 * `unit:geo-locate` (T24 §10.3, T24-080 to T24-084; plan #231 §5): fixtures L, C, E and G0 against
 * gazetteer T, the coordinate aliases (X1–X3), row identity, the normal form and totality.
 */
import { describe, expect, it } from 'vitest';
import type { Labels } from '../../data/frames';
import {
  GEO_ALIAS_KEYS,
  GEO_AUTO_RULES,
  HINT_KEY,
  LAT_ALIASES,
  LON_ALIASES,
  normKey,
} from './aliases';
import { decodeGazetteer } from './decode';
import gazT from './fixtures/gaz-t.json';
import { locate, type GeoSource, type LocationOption, type LocationResult } from './locate';
import type { Gazetteer } from './types';

function gazetteer(extraCountries: unknown[][] = []): Gazetteer {
  const j = structuredClone(gazT) as { country: unknown[][] };
  j.country.push(...extraCountries);
  const g = decodeGazetteer(j);
  expect(g).not.toBeNull();
  return g as Gazetteer;
}

const AUTO: LocationOption = { mode: 'auto' };
type S = string | null;

function P(
  source: GeoSource,
  key: string,
  code: S,
  provider: S,
  name: S,
  lat: number,
  lon: number,
  cell: { dLat: number; dLon: number } | null = null,
): LocationResult {
  return { status: 'placed', place: { lat, lon, source, key, code, provider, name, cell } };
}
const I = (reason: 'coords' | 'incompleteCoords' | 'geohash', key: string): LocationResult => ({
  status: 'invalid',
  reason,
  key,
});
const U = (source: GeoSource, key: string, value: string): LocationResult => ({
  status: 'unknownCode',
  source,
  key,
  value,
});
const M = (key: string, provider: string, candidates: string[]): LocationResult => ({
  status: 'providerMismatch',
  key,
  provider,
  candidates,
});
const A = (
  reason: 'keyCollision' | 'aliasConflict' | 'sharedCode' | 'name' | 'providers' | 'regionOrCloud',
  candidates: string[],
): LocationResult => ({ status: 'ambiguous', reason, candidates });
const N: LocationResult = { status: 'noLocation' };
const DUBLIN = (key: string): LocationResult =>
  P('cloud', key, 'eu-west-1', 'aws', 'Dublin', 53.34, -6.25);

const AUTO_CASES: [string, Labels, LocationResult][] = [
  ['L1', { cloud_region: 'eu-west-1' }, DUBLIN('cloud_region')],
  [
    'L2',
    { 'cloud.region': 'EU-WEST-2' },
    P('cloud', 'cloud.region', 'eu-west-2', 'aws', 'London', 51.5, -0.12),
  ],
  [
    'L3',
    { cloud_provider: 'gcp', cloud_region: 'europe-west1' },
    P('cloud', 'cloud_region', 'europe-west1', 'gcp', 'Mons', 50.45, 3.94),
  ],
  [
    'L4',
    { cloud_provider: 'gcp', cloud_region: 'eu-west-1' },
    M('cloud_region', 'gcp', ['aws eu-west-1']),
  ],
  ['L5', { cloud_region: 'xx-dup-1' }, A('providers', ['ta xx-dup-1', 'tb xx-dup-1'])],
  [
    'L6',
    { cloud_provider: 'ta', cloud_region: 'xx-dup-1' },
    P('cloud', 'cloud_region', 'xx-dup-1', 'ta', 'T1', 10, 10),
  ],
  ['L7', { cloud_region: 'mars-north-1' }, U('cloud', 'cloud_region', 'mars-north-1')],
  [
    'L8',
    { 'cloud.region': 'eu-west-1', cloud_region: 'eu-west-2' },
    A('keyCollision', ['cloud.region=eu-west-1', 'cloud_region=eu-west-2']),
  ],
  ['L9', { 'cloud.region': 'eu-west-1', cloud_region: 'eu-west-1' }, DUBLIN('cloud.region')],
  ['L10', { lat: '0', lon: '0' }, P('coords', 'lat', null, null, null, 0, 0)],
  [
    'L11',
    { lat: '40.7128', lon: '-74.0060' },
    P('coords', 'lat', null, null, null, 40.7128, -74.006),
  ],
  ['L12', { lat: '91', lon: '0' }, I('coords', 'lat')],
  ['L13', { lat: '1.5\n', lon: '2' }, I('coords', 'lat')],
  ['L14', { latitude: '10' }, I('incompleteCoords', 'latitude')],
  ['L15', { lat: '10', latitude: '11', lon: '5' }, A('aliasConflict', ['lat=10', 'latitude=11'])],
  ['L16', { lat: '10', latitude: '10.0', lon: '5' }, P('coords', 'lat', null, null, null, 10, 5)],
  ['L17', { lat: '', lon: '', cloud_region: 'eu-west-1' }, DUBLIN('cloud_region')],
  [
    'L18',
    { geohash: 'u4pruydqqvj' },
    P('geohash', 'geohash', 'u4pruydqqvj', null, null, 57.64911063015461, 10.407439693808556, {
      dLat: 1.341104507446289e-6,
      dLon: 1.341104507446289e-6,
    }),
  ],
  ['L19', { geohash: 'U4PA' }, I('geohash', 'geohash')],
  [
    'L20',
    { geo_country_iso_code: 'jp' },
    P('country', 'geo_country_iso_code', 'JP', null, 'Japan', 36, 138),
  ],
  ['L21', { country: 'atlantis' }, A('name', ['XA Atlantis', 'XB Atlantis'])],
  [
    'L22',
    { country_code: 'JP', country: 'Georgia' },
    A('aliasConflict', ['country=Georgia', 'country_code=JP']),
  ],
  [
    'L23',
    { geo_region_iso_code: 'us-ca' },
    P('region', 'geo_region_iso_code', 'US-CA', null, 'California', 37, -120),
  ],
  ['L24', { region_iso_code: 'KZ-ALA' }, A('sharedCode', ['KZ-ALA Almaty', 'KZ-ALA Almaty City'])],
  ['L25', { airport: 'QQQ' }, A('sharedCode', ['QQQ Alpha', 'QQQ Beta'])],
  ['L26', { region: 'xx-dup' }, A('regionOrCloud', ['XX-DUP Dupland', 'tc xx-dup'])],
  ['L27', { region: 'eu-west-1' }, DUBLIN('region')],
  ['L28', { service: 'web' }, N],
  [
    'L31',
    { cloud_provider: 'oci', cloud_region: 'us-ashburn-1' },
    U('cloud', 'cloud_region', 'us-ashburn-1'),
  ],
  ['L32', { lat: '-0', lon: '180' }, P('coords', 'lat', null, null, null, 0, 180)],
  ['L33', { lat: '1', lon: '180.0001' }, I('coords', 'lon')],
  ['L34', { country: 'ZZ' }, A('sharedCode', ['ZZ Zed North', 'ZZ Zed South'])],
  ['L35', { country: 'zzz' }, A('sharedCode', ['ZZ Zed North', 'ZZ Zed South'])],
  ['C1', { Service: 'a', service: 'b', cloud_region: 'eu-west-1' }, DUBLIN('cloud_region')],
  ['C2', { iata: 'SIN', airport: 'ZZZ' }, U('iata', 'airport', 'ZZZ')],
  ['C3', { iata: 'SIN', airport: 'QQQ' }, A('sharedCode', ['QQQ Alpha', 'QQQ Beta'])],
  ['C4', { lat: '10', latitude: 'x', lon: '5' }, I('coords', 'latitude')],
  ['C5', { lat: '91', lon: '0', cloud_region: 'eu-west-1' }, I('coords', 'lat')],
  [
    'C6',
    { cloud_provider: 'tz', cloud_region: 'xx-dup-1' },
    M('cloud_region', 'tz', ['ta xx-dup-1', 'tb xx-dup-1']),
  ],
  [
    'C7',
    { 'cloud.provider': 'aws', cloud_provider: 'gcp', cloud_region: 'eu-west-1' },
    A('keyCollision', ['cloud.provider=aws', 'cloud_provider=gcp']),
  ],
  [
    'C8',
    { geohash: 'u4pr', cloud_region: 'eu-west-1' },
    P('geohash', 'geohash', 'u4pr', null, null, 57.568359375, 10.37109375, {
      dLat: 0.17578125,
      dLon: 0.3515625,
    }),
  ],
  ['C9', { iata: 'ZZZ', airport: 'QQQ' }, U('iata', 'iata', 'ZZZ')],
  // Coordinate aliases (plan #231 §4.1 step 4a).
  [
    'X1',
    { lat: '10', latitude: '10.0', lon: '5', lng: '5.000' },
    P('coords', 'lat', null, null, null, 10, 5),
  ],
  ['X2', { lat: '10', lon: '5', lng: '6' }, A('aliasConflict', ['lng=6', 'lon=5'])],
  ['X3', { lat: '10', latitude: '11', lon: 'x' }, I('coords', 'lon')],
];

const XY: LocationOption = { mode: 'coords', lat: 'y', lon: 'x' };
const STATE: LocationOption = {
  mode: 'lookup',
  field: 'state',
  gazetteer: 'region',
  country: 'US',
};
const EXPLICIT: [string, Labels, LocationOption, LocationResult][] = [
  ['E1', { y: '0', x: '0' }, XY, P('coords', 'y', null, null, null, 0, 0)],
  ['E2', { y: '1' }, XY, I('incompleteCoords', 'y')],
  ['E3', { lat: '1', lon: '2' }, XY, N],
  ['E4', { y: '1', x: 'east' }, XY, I('coords', 'x')],
  [
    'E5',
    { site: 'SIN', Site: 'LHR' },
    { mode: 'lookup', field: 'site', gazetteer: 'iata' },
    A('keyCollision', ['Site=LHR', 'site=SIN']),
  ],
  ['E6', { state: 'CA' }, STATE, P('region', 'state', 'US-CA', null, 'California', 37, -120)],
  ['E7', { state: 'US-CA' }, STATE, P('region', 'state', 'US-CA', null, 'California', 37, -120)],
  ['E8', { gh: 'u4pa' }, { mode: 'geohash', field: 'gh' }, I('geohash', 'gh')],
  ['E9', {}, { mode: 'geohash', field: 'gh' }, N],
];

describe('unit:geo-locate (T24 §10.3)', () => {
  const g = gazetteer();
  it.each(AUTO_CASES)('%s (auto)', (_n, labels, want) => {
    expect(locate(labels, AUTO, g)).toStrictEqual(want);
  });
  it.each(EXPLICIT)('%s (explicit)', (_n, labels, o, want) => {
    expect(locate(labels, o, g)).toStrictEqual(want);
  });
  it('G0: no gazetteer', () => {
    expect(locate({ cloud_region: 'eu-west-1' }, AUTO, null)).toStrictEqual({
      status: 'gazetteerUnavailable',
    });
    expect(locate({ lat: '1', lon: '2' }, AUTO, null)).toStrictEqual(
      P('coords', 'lat', null, null, null, 1, 2),
    );
  });
});

describe('unit:geo-locate (row identity, T24-081)', () => {
  const g = gazetteer([
    ['YY', 'YYA', 'Yland', 0, 0],
    ['YY', 'YYB', 'Yland', 100, 100],
  ]);
  it('two aliases placing different rows with one code and name conflict', () => {
    expect(locate({ geo_country_iso_code: 'YYA', country_code: 'YYB' }, AUTO, g)).toStrictEqual(
      A('aliasConflict', ['country_code=YYB', 'geo_country_iso_code=YYA']),
    );
    expect(locate({ geo_country_iso_code: 'YYA' }, AUTO, g)).toStrictEqual(
      P('country', 'geo_country_iso_code', 'YY', null, 'Yland', 0, 0),
    );
  });
});

/** mulberry32 */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('unit:geo-locate (normal form, totality; T24-080, T24-081)', () => {
  it('normKey lower-cases ASCII letters and reads . as _', () => {
    expect(normKey('Cloud.Region')).toBe('cloud_region');
    expect(normKey('Ünit.X')).toBe('Ünit_x');
  });
  it('GEO_AUTO_RULES equals §4.10 row by row', () => {
    expect(LAT_ALIASES).toStrictEqual(['lat', 'latitude', 'geo_location_lat']);
    expect(LON_ALIASES).toStrictEqual(['lon', 'lng', 'longitude', 'geo_location_lon']);
    expect(HINT_KEY).toBe('cloud_provider');
    expect(GEO_AUTO_RULES.map((r) => [r.rule, r.kind, [...r.aliases]])).toStrictEqual([
      [
        1,
        'coords',
        ['lat', 'latitude', 'geo_location_lat', 'lon', 'lng', 'longitude', 'geo_location_lon'],
      ],
      [2, 'geohash', ['geohash', 'geo_hash']],
      [3, 'cloud', ['cloud_region']],
      [4, 'region', ['geo_region_iso_code', 'region_iso_code']],
      [5, 'country', ['geo_country_iso_code', 'country_code', 'country']],
      [6, 'iata', ['iata', 'iata_code', 'airport']],
      [7, 'regionOrCloud', ['region']],
    ]);
    expect([...GEO_ALIAS_KEYS].sort()).toStrictEqual(
      GEO_AUTO_RULES.flatMap((r) => r.aliases).sort(),
    );
    expect(GEO_ALIAS_KEYS.has(HINT_KEY)).toBe(false);
  });
  it('500 random label maps: total, deterministic, inputs untouched', () => {
    const g = gazetteer();
    const next = rng(231);
    const keys = [...GEO_ALIAS_KEYS, 'x', 'Lat', 'CLOUD.REGION', HINT_KEY];
    const values = [
      ...new Set([...AUTO_CASES, ...EXPLICIT].flatMap(([, labels]) => Object.values(labels))),
      '',
    ];
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T;
    expect(GEO_ALIAS_KEYS.size).toBeGreaterThan(0);
    for (let i = 0; i < 500; i++) {
      const labels: Record<string, string> = {};
      const n = 1 + Math.floor(next() * 5);
      for (let k = 0; k < n; k++) labels[pick(keys)] = pick(values);
      const frozen = Object.freeze({ ...labels });
      const a = locate(frozen, AUTO, g);
      const b = locate(frozen, AUTO, g);
      expect(b).toStrictEqual(a);
      expect(b).not.toBe(a);
      expect(Object.isFrozen(a)).toBe(true);
      expect(frozen).toStrictEqual(labels);
    }
  });
});
