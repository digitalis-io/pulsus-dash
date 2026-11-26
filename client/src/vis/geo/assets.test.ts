/**
 * `unit:geo-decode`, `unit:geo-assets` and `unit:geo-load` (T24 §10.3, T24-087; plan #231 §5): the
 * build fixtures decode and the malformed assets do not; the bundled assets decode, cover the
 * inventory and match the manifest; the loader fetches once per page and nulls a failed asset.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeBasemap, decodeGazetteer, geoLoader } from './assets';
import { locate } from './locate';
import type { Basemap, Gazetteer } from './types';

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const ROOT = here('../../../../');

function readJson(path: string): unknown {
  expect(existsSync(path), path).toBe(true);
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}
const fixture = (name: string): unknown => readJson(here(`./fixtures/build/${name}.json`));

type Json = unknown[] | Record<string, unknown>;
/** A copy of `j` with the value at `path` replaced. */
function mutate(j: unknown, path: (string | number)[], value: unknown): unknown {
  const out = structuredClone(j);
  let o = out as Json;
  for (const k of path.slice(0, -1)) o = (o as Record<string | number, unknown>)[k] as Json;
  (o as Record<string | number, unknown>)[path[path.length - 1] as string | number] = value;
  return out;
}

describe('unit:geo-decode (T24-087)', () => {
  it.each(['rt', 'rot', 'holeclamp', 'ant', 'enclave', 'sliver', 'ell'])('%s decodes', (name) => {
    expect(decodeBasemap(fixture(name))).not.toBeNull();
  });
  it('round trip: RT', () => {
    const b = decodeBasemap(fixture('rt')) as Basemap;
    expect(b).not.toBeNull();
    expect(b.countries.map((c) => [c.a2, c.a3, c.name])).toStrictEqual([
      ['AA', 'AAA', 'Alpha'],
      ['BB', 'BBB', 'Beta'],
    ]);
    expect(b.countries[0]?.polygons[0]?.[0]).toStrictEqual(
      new Int32Array([0, 0, 1000, 0, 1000, 1000, 0, 1000]),
    );
    expect(b.countries[0]?.polygons[0]?.[1]).toStrictEqual(
      new Int32Array([200, 200, 200, 400, 400, 400, 400, 200]),
    );
    expect(b.coast).toHaveLength(4);
    expect(b.border).toHaveLength(1);
    expect(b.border[0]).toStrictEqual(new Int32Array([1000, 0, 1000, 1000]));
  });

  const MALFORMED: [string, (rt: unknown) => unknown][] = [
    ['M1', () => null],
    ['M2', () => []],
    ['M3', (rt) => mutate(rt, ['v'], 2)],
    ['M4', (rt) => mutate(rt, ['x'], 1)],
    ['M5', (rt) => mutate(rt, ['countries', 0, 3, 0, 0], [0, 0, 1000, 0, 0, 1000, -1000])],
    ['M6', (rt) => mutate(rt, ['countries', 0, 3, 1, 0], [2000, 0, 1000, 0, -1000, 0])],
    ['M7', (rt) => mutate(rt, ['countries', 0, 3, 0, 1], [200, 200, 200, 0, 0, 200, -200, 0])],
    ['M8', (rt) => mutate(rt, ['countries', 0, 3, 0, 1], [1200, 200, 0, 200, 200, 0, 0, -200])],
    ['M9', (rt) => mutate(rt, ['countries', 0, 3, 1, 0], [2000.5, 0, 1000, 0, -500, 500])],
    ['M10', (rt) => mutate(rt, ['countries', 1, 3, 0, 0], [1000, 0, 500, 0, 0, 8506, -500, 0])],
    ['M11', (rt) => mutate(rt, ['coast', 0], [-9000, 100, 18001, 0])],
    ['M12', (rt) => mutate(rt, ['countries', 1, 3], [])],
    ['M13', (rt) => mutate(rt, ['countries', 0, 0], 'aa')],
    ['M14', (rt) => mutate(rt, ['border', 0], [1000, 0])],
    ['M15', (rt) => mutate(rt, ['coast', 0], [-18000, -8505, 36000, 0])],
  ];
  it.each(MALFORMED)('%s → null', (_n, make) => {
    const rt = fixture('rt');
    expect(decodeBasemap(rt)).not.toBeNull();
    expect(decodeBasemap(make(rt))).toBeNull();
  });
  it.each(['corner', 'cross', 'touch', 'collinear', 'nested'])('the ×100 %s asset → null', (n) => {
    expect(() => decodeBasemap(fixture(n))).not.toThrow();
    expect(decodeBasemap(fixture(n))).toBeNull();
  });

  const G0 = {
    v: 1,
    q: 100,
    country: [['JP', 'JPN', 'Japan', 13800, 3600]],
    region: [['US-CA', 'California', -12000, 3700]],
    iata: [['SIN', 'Singapore', 10399, 135]],
    cloud: [['aws', 'eu-west-1', 'Dublin', -625, 5334]],
  };
  it('G0 decodes', () => {
    const g = decodeGazetteer(G0) as Gazetteer;
    expect(g).not.toBeNull();
    expect(g.country).toStrictEqual([{ a2: 'JP', a3: 'JPN', name: 'Japan', x: 13800, y: 3600 }]);
    expect(g.cloudById.get('eu-west-1')).toStrictEqual([
      { provider: 'aws', id: 'eu-west-1', place: 'Dublin', x: -625, y: 5334 },
    ]);
    expect(g.countryByName.get('japan')).toHaveLength(1);
    expect(Object.isFrozen(g.country[0])).toBe(true);
  });
  const noCloud = Object.fromEntries(Object.entries(G0).filter(([k]) => k !== 'cloud'));
  const BAD_GAZ: [string, unknown][] = [
    ['G1', mutate(G0, ['country', 0], ['JP', 'JPN', 'Japan', 13800])],
    ['G2', mutate(G0, ['region', 0, 0], 'usca')],
    ['G3', mutate(G0, ['iata', 0, 2], 18001)],
    ['G4', mutate(G0, ['cloud', 0, 0], 'AWS')],
    ['G5', mutate(G0, ['iata', 0, 1], '')],
    ['G6', noCloud],
    ['G7', mutate(G0, ['country', 0, 4], 36.5)],
    ['G8', 'x'],
  ];
  it.each(BAD_GAZ)('%s → null', (_n, j) => {
    expect(() => decodeGazetteer(j)).not.toThrow();
    expect(decodeGazetteer(j)).toBeNull();
  });
});

interface Manifest {
  assets: { file: string; sha256: string; bytes: number }[];
}

describe('unit:geo-assets (VIZ-045, VIZ-046)', () => {
  const basemapPath = `${ROOT}client/src/vis/geo/data/basemap.json`;
  const gazetteerPath = `${ROOT}client/src/vis/geo/data/gazetteer.json`;
  it('the bundled assets decode, match the manifest and cover the inventory', () => {
    const b = decodeBasemap(readJson(basemapPath));
    const g = decodeGazetteer(readJson(gazetteerPath));
    expect(b).not.toBeNull();
    expect(g).not.toBeNull();
    const gz = g as Gazetteer;
    expect((b as Basemap).countries.length).toBeGreaterThan(0);
    expect(gz.country).toHaveLength(238);
    expect(gz.region.length).toBeGreaterThanOrEqual(4300);
    expect(gz.iata.length).toBeGreaterThanOrEqual(3200);

    const inv = readJson(here('./fixtures/cloud-inventory.json')) as {
      asOf: string;
      providers: Record<string, string[]>;
    };
    const ids: Record<string, string[]> = {};
    for (const r of gz.cloud) (ids[r.provider] ??= []).push(r.id);
    expect(Object.keys(ids).sort()).toStrictEqual(['aws', 'azure', 'gcp']);
    for (const p of Object.keys(inv.providers)) {
      expect([...(ids[p] ?? [])].sort(), p).toStrictEqual([...(inv.providers[p] ?? [])].sort());
    }
    expect(Object.keys(inv.providers).sort()).toStrictEqual(['aws', 'azure', 'gcp']);
    const csv = readFileSync(`${ROOT}tools/geo/cloud-regions.csv`, 'utf8');
    expect(csv.split('\n')[0]).toBe(`# as of ${inv.asOf}`);
    // Government, sovereign and China partitions are excluded; azure restricted-access regions
    // are on the published list and included; ids not on it (the Jio regions) are not.
    for (const r of gz.cloud) expect(r.id).not.toMatch(/gov|iso|cn-|china|eusc/);
    const azure = new Set(ids['azure']);
    for (const id of ['australiacentral2', 'brazilsoutheast', 'uaecentral']) {
      expect(azure.has(id), id).toBe(true);
    }
    for (const id of ['jioindiacentral', 'jioindiawest', 'saudiarabiaeast']) {
      expect(azure.has(id), id).toBe(false);
    }

    expect(locate({ cloud_region: 'eu-west-1' }, { mode: 'auto' }, gz)).toStrictEqual({
      status: 'placed',
      place: {
        lat: 53.34,
        lon: -6.25,
        source: 'cloud',
        key: 'cloud_region',
        code: 'eu-west-1',
        provider: 'aws',
        name: 'Dublin',
        cell: null,
      },
    });
    const at = (provider: string, id: string): unknown => {
      const r = locate({ cloud_provider: provider, cloud_region: id }, { mode: 'auto' }, gz);
      return r.status === 'placed' ? [r.place.name, r.place.lat, r.place.lon] : r;
    };
    // The published place; its position is the Natural Earth populated place Mons (ne_id).
    expect(at('gcp', 'europe-west1')).toStrictEqual(['St. Ghislain', 50.45, 3.94]);
    expect(at('azure', 'westeurope')).toStrictEqual(['Amsterdam', 52.35, 4.91]);
  });
  it('SHA-256 and byte length equal the manifest', () => {
    const m = readJson(`${ROOT}tools/geo/manifest.json`) as Manifest;
    expect(m.assets.map((a) => a.file)).toStrictEqual([
      'client/src/vis/geo/data/basemap.json',
      'client/src/vis/geo/data/gazetteer.json',
    ]);
    for (const a of m.assets) {
      const data = readFileSync(`${ROOT}${a.file}`);
      expect(createHash('sha256').update(data).digest('hex'), a.file).toBe(a.sha256);
      expect(data.length, a.file).toBe(a.bytes);
    }
  });
});

describe('unit:geo-load (T24-087)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  const URLS = { basemap: '/assets/basemap-x.json', gazetteer: '/assets/gazetteer-x.json' };
  const BASEMAP = () => JSON.stringify(fixture('rt'));
  const GAZ = () =>
    JSON.stringify({
      v: 1,
      q: 100,
      country: [['JP', 'JPN', 'Japan', 13800, 3600]],
      region: [],
      iata: [],
      cloud: [],
    });
  type Serve = Record<string, () => Response | Promise<Response>>;
  function stub(serve: Serve) {
    return vi.fn((url: string, init: RequestInit) => {
      expect(init).toBeTypeOf('object');
      const f = serve[url];
      return f === undefined ? Promise.reject(new Error('unexpected url')) : Promise.resolve(f());
    });
  }
  const ok = (body: string) => () => new Response(body, { status: 200 });

  it('ok + ok: both assets, two requests with force-cache, then one shared promise', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const get = stub({ [URLS.basemap]: ok(BASEMAP()), [URLS.gazetteer]: ok(GAZ()) });
    const load = geoLoader(get, URLS);
    const p = load();
    const d = await p;
    expect(d.basemap).not.toBeNull();
    expect(d.gazetteer).not.toBeNull();
    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls.map((c) => c[0]).sort()).toStrictEqual([URLS.basemap, URLS.gazetteer]);
    for (const c of get.mock.calls) expect(c[1]).toStrictEqual({ cache: 'force-cache' });
    expect(load()).toBe(p);
    expect(load()).toBe(p);
    expect(get).toHaveBeenCalledTimes(2);
    expect(debug).not.toHaveBeenCalled();
  });

  it.each([
    ['404 basemap', 'basemap', () => new Response('no', { status: 404 }), 'basemap.json'],
    ['bad JSON gazetteer', 'gazetteer', ok('not json'), 'gazetteer.json'],
    ['invalid gazetteer', 'gazetteer', ok('{"v":2}'), 'gazetteer.json'],
    ['invalid basemap', 'basemap', ok('{"v":1}'), 'basemap.json'],
  ] as const)(
    '%s → that asset null, the other intact, one debug line',
    async (_n, which, res, file) => {
      const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
      const serve: Serve = { [URLS.basemap]: ok(BASEMAP()), [URLS.gazetteer]: ok(GAZ()) };
      serve[URLS[which]] = res;
      const d = await geoLoader(stub(serve), URLS)();
      expect(d[which]).toBeNull();
      expect(d[which === 'basemap' ? 'gazetteer' : 'basemap']).not.toBeNull();
      expect(debug).toHaveBeenCalledTimes(1);
      expect(String(debug.mock.calls[0]?.[0])).toContain(file);
    },
  );

  it('a rejecting get → both null, no rejection', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const get = vi.fn(() => Promise.reject(new Error('offline')));
    const d = await geoLoader(get, URLS)();
    expect(d).toStrictEqual({ basemap: null, gazetteer: null });
    expect(get).toHaveBeenCalledTimes(2);
    expect(debug).toHaveBeenCalledTimes(2);
  });
});
