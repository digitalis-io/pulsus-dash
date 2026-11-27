/**
 * The geomap frame fixtures of T24 §10.4 and §10.5 as series (plan #234 Part 1 §2): G, the group
 * fixtures H, H′, A, O, O2, Q, D, S, S1, the interaction fixtures G3, F1, R, V, M12, N and X, and
 * Cap, with gazetteer T (§10.3, `gaz-t.json`) decoded. Keys are the fixture names (`k01`, `h0`, …):
 * the geomap orders keys by UTF-16 code units and never needs hashes.
 */
import type { Completeness } from '../../../data/decode';
import type { Labels, SeriesFrame } from '../../../data/frames';
import type { Thresholds } from '../../thresholds';
import { decodeGazetteer } from '../decode';
import type { GeomapOptions } from '../frame';
import type { Gazetteer } from '../types';
import gazTJson from './gaz-t.json';

/** The instant fixtures' one sample time. */
export const T0 = 1_764_000_000_000;

/** Gazetteer T (T24 §10.3), decoded. */
export function gazT(): Gazetteer {
  const g = decodeGazetteer(structuredClone(gazTJson));
  if (g === null) throw new Error('gaz-t.json does not decode');
  return g;
}

/** One instant series: `value` at `T0`. */
export function inst(key: string, labels: Labels, value: number): SeriesFrame {
  return {
    key,
    labels,
    timestamps: new Float64Array([T0]),
    values: new Float64Array([value]),
  };
}

/** One range series: the samples `[seconds, value]`, from the epoch (R: `atMs` 60 000). */
export function range(
  key: string,
  labels: Labels,
  samples: readonly [number, number][],
): SeriesFrame {
  return {
    key,
    labels,
    timestamps: Float64Array.from(samples.map(([s]) => s * 1000)),
    values: Float64Array.from(samples.map(([, v]) => v)),
  };
}

/** The §10.4 thresholds: 150 watch, 200 degraded, 250 failing (above). */
export const TH: Thresholds = {
  direction: 'above',
  steps: [
    { value: 150, state: 'watch', label: '' },
    { value: 200, state: 'degraded', label: '' },
    { value: 250, state: 'failing', label: '' },
  ],
};

const pad2 = (i: number): string => String(i).padStart(2, '0');

/** A complete run. */
export const COMPLETE: Completeness = Object.freeze({
  truncated: false,
  warnings: [],
  infos: [],
  queryId: null,
  dataAgeMs: null,
  readCache: null,
  readCacheThroughMs: null,
});

/** The geomap options with their defaults (§3.3), `over` applied. */
export function opts(over: Partial<GeomapOptions> = {}): GeomapOptions {
  return {
    location: { mode: 'auto' },
    reducer: 'last',
    size: { by: 'value', min: 4, max: 20 },
    colour: 'group',
    groupBy: null,
    symbol: 'circle',
    labels: 'auto',
    cluster: true,
    wheelZoom: true,
    view: null,
    ...over,
  };
}

/** Fixture G (§10.4), in key order; k02 is two series (95, then 97 at the same time). */
export function G(over: Partial<Record<string, number>> = {}): SeriesFrame[] {
  const v = (key: string, x: number): number => over[key] ?? x;
  return [
    inst('k01', { cloud_region: 'eu-west-1' }, v('k01', 120)),
    inst('k02', { cloud_region: 'eu-west-2' }, 95),
    inst('k02', { cloud_region: 'eu-west-2' }, 97),
    inst('k03', { cloud_provider: 'gcp', cloud_region: 'europe-west1' }, v('k03', 210)),
    inst('k04', { cloud_region: 'westeurope' }, v('k04', 180)),
    inst('k05', { geo_country_iso_code: 'jp' }, v('k05', 60)),
    inst('k06', { iata: 'sin' }, v('k06', 40)),
    inst('k07', { lat: '40.7128', lon: '-74.0060' }, v('k07', 300)),
    inst('k08', { geohash: 'u4pruydqqvj' }, v('k08', 75)),
    inst('k09', { cloud_region: 'mars-north-1' }, v('k09', 50)),
    inst('k10', { lat: '91', lon: '0' }, NaN),
    inst('k11', { cloud_region: 'xx-dup-1' }, v('k11', 20)),
    inst('k12', { lat: '10', lon: '10' }, NaN),
    inst('k13', { lat: '-89.9', lon: '0' }, v('k13', 5)),
    inst('k14', { lat: '0', lon: '0' }, v('k14', -30)),
    inst('k15', { service: 'web' }, v('k15', 1)),
    inst('k16', { lat: '20', lon: '20' }, Infinity),
    inst('k17', { lat: '25', lon: '25' }, 5e-300),
    inst('k18', { lat: '40.7128', lon: '-74.0060', site: 'b' }, v('k18', 150)),
  ];
}

/** G3 (§10.5): k01, k05 and k06 of G. */
export function G3(): SeriesFrame[] {
  return G().filter((s) => ['k01', 'k05', 'k06'].includes(s.key));
}

/** H (§10.4): h0…h8, env e0…e8 at lat = lon = 10·j, value 10(j + 1); `h9` adds h9 with no env. */
export function H(h9 = false): SeriesFrame[] {
  const out: SeriesFrame[] = [];
  for (let j = 0; j <= 8; j++) {
    const at = String(10 * j);
    out.push(inst(`h${String(j)}`, { env: `e${String(j)}`, lat: at, lon: at }, 10 * (j + 1)));
  }
  if (h9) out.push(inst('h9', { lat: '5', lon: '5' }, 100));
  return out;
}

/** H′ (§10.4): H with h3 NaN and h8 +Inf. */
export function Hprime(): SeriesFrame[] {
  return H().map((s) =>
    s.key === 'h3'
      ? inst('h3', s.labels, NaN)
      : s.key === 'h8'
        ? inst('h8', s.labels, Infinity)
        : s,
  );
}

/** A (§10.4): a1 no env, a2 env=`env absent`, a3 env=prod. */
export function A(): SeriesFrame[] {
  return [
    inst('a1', { lat: '1', lon: '1' }, 1),
    inst('a2', { env: 'env absent', lat: '2', lon: '2' }, 2),
    inst('a3', { env: 'prod', lat: '3', lon: '3' }, 3),
  ];
}

/** O (§10.4): q0…q9 (keys `q00`…`q09`) with env e0…e6, `other (2)`, e8, e9. */
export function O(): SeriesFrame[] {
  const envs = ['e0', 'e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'other (2)', 'e8', 'e9'];
  return envs.map((env, i) => {
    const at = String(i + 1);
    return inst(`q${pad2(i)}`, { env, lat: at, lon: at }, i + 1);
  });
}

/** O2 (§10.5): O and q10 {env=e8, pod=b}. */
export function O2(): SeriesFrame[] {
  return [...O(), inst('q10', { env: 'e8', lat: '11', lon: '11', pod: 'b' }, 11)];
}

/** Q (§10.4): p1 env=`env absent`, p2 env=`"env absent"`, p3 no env. */
export function Q(): SeriesFrame[] {
  return [
    inst('p1', { env: 'env absent', lat: '1', lon: '1' }, 1),
    inst('p2', { env: '"env absent"', lat: '2', lon: '2' }, 2),
    inst('p3', { lat: '3', lon: '3' }, 3),
  ];
}

/** D (§10.4, no groupBy): d1 {lat="1", lon="2"}, d2 the same with `__name__=""`. */
export function D(): SeriesFrame[] {
  return [
    inst('d1', { lat: '1', lon: '2' }, 1),
    inst('d2', { __name__: '', lat: '1', lon: '2' }, 2),
  ];
}

/** S (§10.4, `labels: none`): s1 prod 100, s2 prod 300, s3 dev 50. */
export function S(): SeriesFrame[] {
  return [
    inst('s1', { env: 'prod', lat: '10', lon: '10' }, 100),
    inst('s2', { env: 'prod', lat: '20', lon: '10' }, 300),
    inst('s3', { env: 'dev', lat: '10', lon: '20' }, 50),
  ];
}

/** S1 (§10.5): s1 and s2 of S. */
export function S1(): SeriesFrame[] {
  return S().slice(0, 2);
}

/** F1 (§10.5, no thresholds): x1 −30, x2 10, x3 10. */
export function F1(): SeriesFrame[] {
  return [
    inst('x1', { lat: '1', lon: '1' }, -30),
    inst('x2', { lat: '2', lon: '2' }, 10),
    inst('x3', { lat: '3', lon: '3' }, 10),
  ];
}

/** R (§10.5, a range result): r1 100, 300, 250 and r2 10, 20, 30 at 0, 60 and 120 s. */
export function R(): SeriesFrame[] {
  return [
    range('r1', { lat: '1', lon: '1' }, [
      [0, 100],
      [60, 300],
      [120, 250],
    ]),
    range('r2', { lat: '2', lon: '2' }, [
      [0, 10],
      [60, 20],
      [120, 30],
    ]),
  ];
}

/** V (§10.5): v1 checkout and v2 payments, both in eu-west-1. */
export function V(): SeriesFrame[] {
  return [
    inst('v1', { cloud_region: 'eu-west-1', service_name: 'checkout' }, 1),
    inst('v2', { cloud_region: 'eu-west-1', service_name: 'payments' }, 2),
  ];
}

/** M12 (§10.5): m01–m12 at lat = lon = 10, pod p01–p12, value i. */
export function M12(): SeriesFrame[] {
  const out: SeriesFrame[] = [];
  for (let i = 1; i <= 12; i++) {
    out.push(inst(`m${pad2(i)}`, { lat: '10', lon: '10', pod: `p${pad2(i)}` }, i));
  }
  return out;
}

/** N (§10.5, `groupBy: env`): n00–n18 with env e0–e18; n19–n29 env e18 with pod p19–p29; value i. */
export function N(): SeriesFrame[] {
  const out: SeriesFrame[] = [];
  for (let i = 0; i <= 29; i++) {
    const labels: Record<string, string> =
      i <= 18 ? { env: `e${String(i)}` } : { env: 'e18', pod: `p${String(i)}` };
    out.push(inst(`n${pad2(i)}`, { ...labels, lat: '10', lon: '10' }, i));
  }
  return out;
}

/** X (§10.5, no thresholds): cloud regions `a,b` 1, `say "hi"` 2, `x` LF `y` 3, `=1` −4. */
export function X(): SeriesFrame[] {
  return [
    inst('x1', { cloud_region: 'a,b' }, 1),
    inst('x2', { cloud_region: 'say "hi"' }, 2),
    inst('x3', { cloud_region: 'x\ny' }, 3),
    inst('x4', { cloud_region: '=1' }, -4),
  ];
}

/** Cap (§10.4): c0000…c5002 at lat (i mod 100) − 50, lon 3⌊i/100⌋ − 75, value i. */
export function Cap(): SeriesFrame[] {
  const out: SeriesFrame[] = [];
  for (let i = 0; i <= 5002; i++) {
    const lat = String((i % 100) - 50);
    const lon = String(3 * Math.floor(i / 100) - 75);
    out.push(inst(`c${String(i).padStart(4, '0')}`, { lat, lon }, i));
  }
  return out;
}

/** A seeded shuffle (mulberry32), for the order-independence rows. */
export function shuffled<T>(xs: readonly T[], seed: number): T[] {
  let a = seed >>> 0;
  const rnd = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const x = out[i] as T;
    out[i] = out[j] as T;
    out[j] = x;
  }
  return out;
}
