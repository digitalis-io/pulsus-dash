/**
 * Whole-asset validation of `basemap.json` and `gazetteer.json` (T24-087, T24 §5.12): a value that
 * fails any check is null, never a partial asset, and nothing throws. Type-only imports, so the
 * `ci:geo-data` script loads this module in Node.
 *
 * The hole predicate is the build's (`tools/geo/build.py` `check_holes`), exact in doubles: every
 * coordinate is an integer with |x| ≤ 18000 and |y| ≤ 8505, so each difference is at most 36000 and
 * each cross product stays far below 2^53.
 */
import type { Basemap, BasemapCountry, CloudRow, CodeRow, CountryRow, Gazetteer } from './types.ts';

const XMAX = 18000;
const YMAX_BASEMAP = 8505;
const YMAX_GAZETTEER = 9000;
const A2_OR_99 = /^(?:[A-Z]{2}|-99)$/;
const A3_OR_99 = /^(?:[A-Z]{3}|-99)$/;
const A2 = /^[A-Z]{2}$/;
const A3 = /^[A-Z]{3}$/;
const REGION = /^[A-Z]{2}-[A-Z0-9]{1,3}$/;
const PROVIDER = /^[a-z][a-z0-9]{1,15}$/;
const CLOUD_ID = /^[a-z0-9-]{1,40}$/;

type Edge = readonly [number, number, number, number];

/** Thrown inside the decoders on the first violation; their boundary turns it into null. */
class Invalid extends Error {}

function fail(): never {
  throw new Invalid('invalid geo asset');
}

function exactKeys(j: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof j !== 'object' || j === null || Array.isArray(j)) fail();
  const o = j as Record<string, unknown>;
  if (Object.keys(o).length !== keys.length || !keys.every((k) => Object.hasOwn(o, k))) fail();
  if (o['v'] !== 1 || o['q'] !== 100) fail();
  return o;
}

function list(j: unknown): readonly unknown[] {
  return Array.isArray(j) ? (j as unknown[]) : fail();
}

function int(v: unknown): number {
  return typeof v === 'number' && Number.isSafeInteger(v) ? v : fail();
}

function str(v: unknown, re: RegExp): string {
  return typeof v === 'string' && re.test(v) ? v : fail();
}

/** A name or place of 1–100 code points. */
function name(v: unknown): string {
  if (typeof v !== 'string') fail();
  let n = 0;
  for (let i = 0; i < v.length; i++) {
    // A low surrogate after a high one completes a code point already counted.
    const low = (v.charCodeAt(i) & 0xfc00) === 0xdc00;
    if (!(low && i > 0 && (v.charCodeAt(i - 1) & 0xfc00) === 0xd800)) n += 1;
  }
  return n >= 1 && n <= 100 ? v : fail();
}

/** A delta array → absolute interleaved integers, each point within the bounds. */
function points(j: unknown, ymax: number): Int32Array {
  const a = list(j);
  if (a.length % 2 !== 0) fail();
  const out = new Int32Array(a.length);
  let x = 0;
  let y = 0;
  for (let i = 0; i < a.length; i += 2) {
    x += int(a[i]);
    y += int(a[i + 1]);
    if (Math.abs(x) > XMAX || Math.abs(y) > ymax) fail();
    out[i] = x;
    out[i + 1] = y;
  }
  return out;
}

/** Point i's coordinates (i an even index into r). */
const X = (r: Int32Array, i: number): number => r[i] ?? 0;
const Y = (r: Int32Array, i: number): number => r[i + 1] ?? 0;

/** Twice the signed area (counter-clockwise positive). */
function area2(r: Int32Array): number {
  let s = 0;
  for (let i = 0; i < r.length; i += 2) {
    const j = (i + 2) % r.length;
    s += X(r, i) * Y(r, j) - X(r, j) * Y(r, i);
  }
  return s;
}

/**
 * No repeated consecutive point (a ring's closing edge included) and |Δx| ≤ 18000, except a ring's
 * polar closure: an edge with both ends on the same y = ±8505.
 */
function checkEdges(r: Int32Array, closed: boolean): void {
  const n = r.length;
  for (let i = closed ? 0 : 2; i < n; i += 2) {
    const p = (i - 2 + n) % n;
    const x0 = X(r, p);
    const y0 = Y(r, p);
    const x1 = X(r, i);
    const y1 = Y(r, i);
    if (x0 === x1 && y0 === y1) fail();
    if (Math.abs(x1 - x0) > XMAX && !(closed && y0 === y1 && Math.abs(y0) === YMAX_BASEMAP)) fail();
  }
}

function ring(j: unknown): Int32Array {
  const r = points(j, YMAX_BASEMAP);
  if (r.length < 6) fail();
  checkEdges(r, true);
  // ≥ 3 distinct points: the first two differ (no repeat), so one point must differ from both.
  let third = false;
  for (let i = 4; i < r.length && !third; i += 2) {
    const x = X(r, i);
    const y = Y(r, i);
    third = !(x === X(r, 0) && y === Y(r, 0)) && !(x === X(r, 2) && y === Y(r, 2));
  }
  if (!third) fail();
  return r;
}

// ---- the hole predicate (T24-087) ----

function orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return Math.sign((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
}

function onBox(ax: number, ay: number, bx: number, by: number, px: number, py: number): boolean {
  return (
    Math.min(ax, bx) <= px &&
    px <= Math.max(ax, bx) &&
    Math.min(ay, by) <= py &&
    py <= Math.max(ay, by)
  );
}

/** The edge ending at point i (from the previous point, cyclically). */
function edge(r: Int32Array, i: number): Edge {
  const p = (i - 2 + r.length) % r.length;
  return [X(r, p), Y(r, p), X(r, i), Y(r, i)];
}

function edgesOf(r: Int32Array): Edge[] {
  const out: Edge[] = [];
  for (let i = 0; i < r.length; i += 2) out.push(edge(r, i));
  return out;
}

/** The closed segments share a point (crossing, touching or collinear overlap). */
function segmentsMeet(s: Edge, t: Edge): boolean {
  const [ax, ay, bx, by] = s;
  const [cx, cy, dx, dy] = t;
  const o1 = orient(ax, ay, bx, by, cx, cy);
  const o2 = orient(ax, ay, bx, by, dx, dy);
  const o3 = orient(cx, cy, dx, dy, ax, ay);
  const o4 = orient(cx, cy, dx, dy, bx, by);
  if (o1 * o2 < 0 && o3 * o4 < 0) return true;
  return (
    (o1 === 0 && onBox(ax, ay, bx, by, cx, cy)) ||
    (o2 === 0 && onBox(ax, ay, bx, by, dx, dy)) ||
    (o3 === 0 && onBox(cx, cy, dx, dy, ax, ay)) ||
    (o4 === 0 && onBox(cx, cy, dx, dy, bx, by))
  );
}

/** Even-odd with cross products; a point on the boundary is not inside. */
function strictlyInside(px: number, py: number, r: Int32Array): boolean {
  let c = false;
  for (let i = 0; i < r.length; i += 2) {
    const [ax, ay, bx, by] = edge(r, i);
    const o = orient(ax, ay, bx, by, px, py);
    if (o === 0 && onBox(ax, ay, bx, by, px, py)) return false;
    if (ay > py !== by > py && (by > ay ? o : -o) > 0) c = !c;
  }
  return c;
}

/**
 * Each hole vertex strictly inside the outer; no hole edge sharing a point with an outer edge or
 * another hole's edge; no hole inside another (with no shared point, one vertex decides).
 */
function holesOk(outer: Int32Array, holes: readonly Int32Array[]): boolean {
  const oe = edgesOf(outer);
  const he = holes.map(edgesOf);
  for (let k = 0; k < holes.length; k++) {
    const h = holes[k] ?? fail();
    for (let i = 0; i < h.length; i += 2) {
      if (!strictlyInside(X(h, i), Y(h, i), outer)) return false;
    }
    for (const s of he[k] ?? []) {
      if (oe.some((t) => segmentsMeet(s, t))) return false;
      for (let m = k + 1; m < holes.length; m++) {
        if ((he[m] ?? []).some((t) => segmentsMeet(s, t))) return false;
      }
    }
    for (let m = k + 1; m < holes.length; m++) {
      const o = holes[m] ?? fail();
      if (strictlyInside(X(o, 0), Y(o, 0), h) || strictlyInside(X(h, 0), Y(h, 0), o)) return false;
    }
  }
  return true;
}

function polygon(j: unknown): readonly Int32Array[] {
  const rings = list(j).map(ring);
  const [outer, ...holes] = rings;
  if (outer === undefined || area2(outer) <= 0) fail();
  if (holes.some((h) => area2(h) >= 0)) fail();
  if (holes.length > 0 && !holesOk(outer, holes)) fail();
  return Object.freeze(rings);
}

function polyline(j: unknown): Int32Array {
  const r = points(j, YMAX_BASEMAP);
  if (r.length < 4) fail();
  checkEdges(r, false);
  return r;
}

function country(j: unknown): BasemapCountry {
  const c = list(j);
  if (c.length !== 4) fail();
  const polygons = list(c[3]).map(polygon);
  if (polygons.length === 0) fail();
  return Object.freeze({
    a2: str(c[0], A2_OR_99),
    a3: str(c[1], A3_OR_99),
    name: name(c[2]),
    polygons: Object.freeze(polygons),
  });
}

/**
 * Runs a decoder: its first violation (`Invalid`) makes the whole asset null (T24-087). The decoders
 * never throw (T24 §5.11), so any other error, which only a value that is not parsed JSON can raise
 * (a throwing getter or proxy), is an invalid asset too.
 */
function whole<T>(decode: () => T): T | null {
  try {
    return decode();
  } catch {
    return null;
  }
}

/** `basemap.json` (T24 §5.12) → `Basemap`, or null on any T24-087 violation. */
export function decodeBasemap(j: unknown): Basemap | null {
  return whole(() => {
    const o = exactKeys(j, ['v', 'q', 'countries', 'coast', 'border']);
    return Object.freeze({
      countries: Object.freeze(list(o['countries']).map(country)),
      coast: Object.freeze(list(o['coast']).map(polyline)),
      border: Object.freeze(list(o['border']).map(polyline)),
    });
  });
}

function xy(r: readonly unknown[], at: number): { x: number; y: number } {
  const x = int(r[at]);
  const y = int(r[at + 1]);
  if (Math.abs(x) > XMAX || Math.abs(y) > YMAX_GAZETTEER) fail();
  return { x, y };
}

function rows<R>(j: unknown, width: number, row: (r: readonly unknown[]) => R): readonly R[] {
  return Object.freeze(
    list(j).map((r) => {
      const a = list(r);
      if (a.length !== width) fail();
      return Object.freeze(row(a));
    }),
  );
}

function index<R>(rs: readonly R[], key: (r: R) => string): ReadonlyMap<string, readonly R[]> {
  const m = new Map<string, R[]>();
  for (const r of rs) {
    const k = key(r);
    const v = m.get(k);
    if (v === undefined) m.set(k, [r]);
    else v.push(r);
  }
  for (const v of m.values()) Object.freeze(v);
  return m;
}

/** `gazetteer.json` (T24 §5.12) → `Gazetteer`, or null on any T24-087 violation. */
export function decodeGazetteer(j: unknown): Gazetteer | null {
  return whole(() => {
    const o = exactKeys(j, ['v', 'q', 'country', 'region', 'iata', 'cloud']);
    const country = rows<CountryRow>(o['country'], 5, (r) => ({
      a2: str(r[0], A2),
      a3: str(r[1], A3),
      name: name(r[2]),
      ...xy(r, 3),
    }));
    const region = rows<CodeRow>(o['region'], 4, (r) => ({
      code: str(r[0], REGION),
      name: name(r[1]),
      ...xy(r, 2),
    }));
    const iata = rows<CodeRow>(o['iata'], 4, (r) => ({
      code: str(r[0], A3),
      name: name(r[1]),
      ...xy(r, 2),
    }));
    const cloud = rows<CloudRow>(o['cloud'], 5, (r) => ({
      provider: str(r[0], PROVIDER),
      id: str(r[1], CLOUD_ID),
      place: name(r[2]),
      ...xy(r, 3),
    }));
    return Object.freeze({
      country,
      region,
      iata,
      cloud,
      countryByA2: index(country, (r) => r.a2),
      countryByA3: index(country, (r) => r.a3),
      countryByName: index(country, (r) => r.name.normalize('NFC').toLowerCase()),
      regionByCode: index(region, (r) => r.code),
      iataByCode: index(iata, (r) => r.code),
      cloudById: index(cloud, (r) => r.id),
    });
  });
}
