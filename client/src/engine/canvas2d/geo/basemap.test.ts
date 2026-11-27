/**
 * `unit:geo-basemap-draw` (T24 §10.3, §10.4, T24-091, VIZ-046; plan #234 Part 2 §4.7, §5): the build
 * outputs RT and ANT, drawn apart on a recording context. A polygon is one `nonzero` fill path with
 * its holes; the coast (1 px) and the shared borders (0.5 px) are each stroked once, and no ring
 * outline (Antarctica's clamped edge, the ±180° seam) is ever stroked.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { colour } from '../../../styles/tokens';
import { recordingContext, type RecordedOp } from '../../../test/recordingContext';
import { decodeBasemap } from '../../../vis/geo/decode';
import type { Basemap } from '../../../vis/geo/types';
import { camOf, contain, toPx, type Cam } from '../../controller/geo/camera';
import { uOf, vOf } from '../../controller/geo/project';
import { drawBasemap, type MapColours } from './basemap';

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
function basemap(name: string): Basemap {
  const j = JSON.parse(
    readFileSync(here(`../../../vis/geo/fixtures/build/${name}.json`), 'utf8'),
  ) as unknown;
  const b = decodeBasemap(j);
  if (b === null) throw new Error(`${name} does not decode`);
  return b;
}

const W = 1024;
const H = 512;
const c = colour.dark;
const COLOURS: MapColours = {
  background: c['surface-1'],
  water: c['map-water'],
  land: c['map-land'],
  coast: c['map-coast'],
  border: c['map-border'],
};

type Pt = [number, number];

/** The subpaths of each `fill`/`stroke`, from the path ops since its `beginPath`. */
function paths(ops: readonly RecordedOp[]): { op: RecordedOp; subpaths: Pt[][] }[] {
  const out: { op: RecordedOp; subpaths: Pt[][] }[] = [];
  let cur: Pt[][] = [];
  for (const o of ops) {
    if (o.op === 'beginPath') cur = [];
    else if (o.op === 'moveTo') cur.push([[o.args[0] as number, o.args[1] as number]]);
    else if (o.op === 'lineTo') cur.at(-1)?.push([o.args[0] as number, o.args[1] as number]);
    else if (o.op === 'fill' || o.op === 'stroke') out.push({ op: o, subpaths: cur });
  }
  return out;
}

/** The nonzero winding number of the closed subpaths around (x, y). */
function winding(subpaths: readonly Pt[][], x: number, y: number): number {
  let w = 0;
  for (const ring of subpaths) {
    for (let i = 0; i < ring.length; i++) {
      const [x0, y0] = ring[i] as Pt;
      const [x1, y1] = ring[(i + 1) % ring.length] as Pt;
      if (y0 <= y && y1 > y && (x1 - x0) * (y - y0) - (x - x0) * (y1 - y0) > 0) w += 1;
      else if (y0 > y && y1 <= y && (x1 - x0) * (y - y0) - (x - x0) * (y1 - y0) < 0) w -= 1;
    }
  }
  return w;
}

function draw(b: Basemap, cam: Cam) {
  const ctx = recordingContext();
  drawBasemap(ctx, b, cam, W, H, COLOURS);
  return paths(ctx.ops);
}

const px = (cam: Cam, lon: number, lat: number) => toPx(cam, uOf(lon), vOf(lat), W, H);

describe('unit:geo-basemap-draw', () => {
  it('RT: one nonzero path per polygon (holes stay water); 4 coast strokes at 1 px, 1 border at 0.5 px', () => {
    const cam = contain(camOf({ lat: 5, lon: 15, zoom: 5 }), W, H);
    const ps = draw(basemap('rt'), cam);
    const fills = ps.filter((p) => p.op.op === 'fill');
    expect(fills.map((p) => p.op.fillStyle)).toEqual([c['map-land'], c['map-land'], c['map-land']]);
    expect(fills.map((p) => p.op.args)).toEqual([['nonzero'], ['nonzero'], ['nonzero']]);
    const square = fills[0];
    expect(square?.subpaths).toHaveLength(2);
    const inside = px(cam, 1, 1);
    const hole = px(cam, 3, 3);
    expect(Math.abs(winding(square?.subpaths ?? [], inside.x, inside.y))).toBe(1);
    expect(winding(square?.subpaths ?? [], hole.x, hole.y)).toBe(0);
    const strokes = ps.filter((p) => p.op.op === 'stroke');
    const coast = strokes.filter((p) => p.op.strokeStyle === c['map-coast']);
    const border = strokes.filter((p) => p.op.strokeStyle === c['map-border']);
    expect(coast).toHaveLength(4);
    expect(coast.every((p) => p.op.lineWidth === 1 && p.subpaths.length === 1)).toBe(true);
    expect(border).toHaveLength(1);
    expect(border[0]?.op.lineWidth).toBe(0.5);
    expect(strokes).toHaveLength(5);
    // The border is Alpha and Beta's shared edge x = 10°, 0°–10°.
    const e0 = px(cam, 10, 0);
    const e1 = px(cam, 10, 10);
    const seg = border[0]?.subpaths[0] ?? [];
    expect(seg[0]?.[0]).toBeCloseTo(e0.x, 9);
    expect(seg[0]?.[1]).toBeCloseTo(e0.y, 9);
    expect(seg[1]?.[1]).toBeCloseTo(e1.y, 9);
  });

  it('ANT: 1 coast stroke, no border, nothing stroked on y = ±85.05° or x = ±180°', () => {
    const cam = contain(camOf({ lat: 0, lon: 0, zoom: 1 }), W, H);
    const ps = draw(basemap('ant'), cam);
    const strokes = ps.filter((p) => p.op.op === 'stroke');
    expect(strokes.filter((p) => p.op.strokeStyle === c['map-coast'])).toHaveLength(1);
    expect(strokes.filter((p) => p.op.strokeStyle === c['map-border'])).toHaveLength(0);
    const yEdge = px(cam, 0, -85.05).y;
    const xs = [px(cam, -180, 0).x, px(cam, 180, 0).x];
    for (const p of strokes) {
      for (const sub of p.subpaths) {
        for (let i = 1; i < sub.length; i++) {
          const [x0, y0] = sub[i - 1] as Pt;
          const [x1, y1] = sub[i] as Pt;
          expect(Math.abs(y0 - yEdge) < 0.01 && Math.abs(y1 - yEdge) < 0.01).toBe(false);
          for (const x of xs) {
            expect(Math.abs(x0 - x) < 0.01 && Math.abs(x1 - x) < 0.01).toBe(false);
          }
        }
      }
    }
    expect(ps.filter((p) => p.op.op === 'fill')).toHaveLength(1);
  });
});
