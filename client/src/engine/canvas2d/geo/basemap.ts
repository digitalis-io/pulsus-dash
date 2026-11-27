/**
 * The geomap's basemap painter (T24-091, VIZ-046; plan #234 Part 2 §4.7). The asset's rings and
 * polylines are projected once per basemap to world units (cached, view-independent); per frame only
 * a scale and an offset apply. Land is one path per polygon (its outer ring and holes) filled
 * `nonzero` by the asset's orientations, so holes stay water; the coast (1 px) and the shared borders
 * (0.5 px) are stroked from their own polylines, each once, so no ring outline (a clamped polar edge,
 * the ±180° seam) is ever drawn. The world has no repeat: outside it is `surface-1`.
 */
import type { Cam } from '../../controller/geo/camera';
import { vOf, worldPx } from '../../controller/geo/project';
import type { Basemap } from '../../../vis/geo/types';
import type { Ctx2D } from '../ctx';

export interface MapColours {
  readonly background: string;
  readonly water: string;
  readonly land: string;
  readonly coast: string;
  readonly border: string;
}

/** A projected line: interleaved u, v and its world box. */
interface Line {
  readonly uv: Float64Array;
  readonly box: readonly [number, number, number, number];
}

interface Projected {
  /** Per polygon: the outer ring, then its holes. */
  readonly polygons: readonly (readonly Line[])[];
  readonly coast: readonly Line[];
  readonly border: readonly Line[];
}

const cache = new WeakMap<Basemap, Projected>();

/** Hundredths of a degree to world units; x as stored (no wrap), y through Web Mercator. */
function project(xy: Int32Array): Line {
  const uv = new Float64Array(xy.length);
  let u0 = Infinity;
  let v0 = Infinity;
  let u1 = -Infinity;
  let v1 = -Infinity;
  for (let i = 0; i + 1 < xy.length; i += 2) {
    const u = ((xy[i] ?? 0) / 100 + 180) / 360;
    const v = vOf((xy[i + 1] ?? 0) / 100);
    uv[i] = u;
    uv[i + 1] = v;
    u0 = Math.min(u0, u);
    u1 = Math.max(u1, u);
    v0 = Math.min(v0, v);
    v1 = Math.max(v1, v);
  }
  return { uv, box: [u0, v0, u1, v1] };
}

function projected(b: Basemap): Projected {
  let p = cache.get(b);
  if (p === undefined) {
    p = {
      polygons: b.countries.flatMap((c) => c.polygons.map((rings) => rings.map(project))),
      coast: b.coast.map(project),
      border: b.border.map(project),
    };
    cache.set(b, p);
  }
  return p;
}

/** The plot's world box under `cam`, for culling. */
function viewBox(cam: Cam, w: number, h: number, S: number): [number, number, number, number] {
  return [cam.u - w / 2 / S, cam.v - h / 2 / S, cam.u + w / 2 / S, cam.v + h / 2 / S];
}

const outside = (b: Line['box'], v: readonly number[]): boolean =>
  b[2] < (v[0] ?? 0) || b[0] > (v[2] ?? 0) || b[3] < (v[1] ?? 0) || b[1] > (v[3] ?? 0);

function trace(ctx: Ctx2D, l: Line, S: number, ox: number, oy: number): void {
  const uv = l.uv;
  for (let i = 0; i + 1 < uv.length; i += 2) {
    const x = ox + (uv[i] ?? 0) * S;
    const y = oy + (uv[i + 1] ?? 0) * S;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
}

function strokeLines(
  ctx: Ctx2D,
  lines: readonly Line[],
  view: readonly number[],
  S: number,
  ox: number,
  oy: number,
): void {
  for (const l of lines) {
    if (outside(l.box, view)) continue;
    ctx.beginPath();
    trace(ctx, l, S, ox, oy);
    ctx.stroke();
  }
}

/** Paints the background, water, land, coast and borders of `b` under `cam` on a `w` × `h` plot. */
export function drawBasemap(
  ctx: Ctx2D,
  b: Basemap,
  cam: Cam,
  w: number,
  h: number,
  c: MapColours,
): void {
  const S = worldPx(cam.z);
  const ox = w / 2 - cam.u * S;
  const oy = h / 2 - cam.v * S;
  ctx.fillStyle = c.background;
  ctx.fillRect(0, 0, w, h);
  const x0 = Math.max(0, ox);
  const y0 = Math.max(0, oy);
  const x1 = Math.min(w, ox + S);
  const y1 = Math.min(h, oy + S);
  ctx.fillStyle = c.water;
  if (x1 > x0 && y1 > y0) ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  const p = projected(b);
  const view = viewBox(cam, w, h, S);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.clip();
  ctx.fillStyle = c.land;
  for (const rings of p.polygons) {
    const outer = rings[0];
    if (outer === undefined || outside(outer.box, view)) continue;
    ctx.beginPath();
    for (const r of rings) trace(ctx, r, S, ox, oy);
    ctx.fill('nonzero');
  }
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = c.coast;
  ctx.lineWidth = 1;
  strokeLines(ctx, p.coast, view, S, ox, oy);
  ctx.strokeStyle = c.border;
  ctx.lineWidth = 0.5;
  strokeLines(ctx, p.border, view, S, ox, oy);
  ctx.restore();
}
