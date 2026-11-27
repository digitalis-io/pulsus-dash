/**
 * `unit:geo-camera` and `unit:geo-ownership` (T24 §10.4, T24-091, INT-002; plan #234 Part 2 §5):
 * the zoom range, inset, fit, containment, persisted views, anchored wheels and their drift, and
 * who owns the camera across specs, data and commits.
 */
import { describe, expect, it } from 'vitest';
import { G } from '../../../vis/geo/fixtures/series';
import { ctlKit, frameOf, shownOf } from '../../../test/geoKit';
import { pointer } from '../../../test/engineHarness';
import { wheelIntent } from '../../canvas2d/input';
import type { GeoView } from '../../api';
import {
  boundsOf,
  camOf,
  contain,
  fitView,
  fromPx,
  insetOf,
  toPx,
  viewOf,
  zoomAbout,
  zoomRange,
  type Cam,
} from './camera';

const EPS = 1e-9;

function expectView(v: GeoView, lat: number, lon: number, zoom: number, eps = EPS): void {
  expect(Math.abs(v.lat - lat), `lat ${String(v.lat)} vs ${String(lat)}`).toBeLessThan(eps);
  expect(Math.abs(v.lon - lon), `lon ${String(v.lon)} vs ${String(lon)}`).toBeLessThan(eps);
  expect(Math.abs(v.zoom - zoom), `zoom ${String(v.zoom)} vs ${String(zoom)}`).toBeLessThan(eps);
}

const G_PTS = shownOf(frameOf());
const FIT: [number, number, number] = [33.388480626497824, 31.996999999999986, 2.6218728064801105];

/** The Δz of a wheel of `deltaY` px over a 1024 × 512 plot. */
function wheelDz(deltaY: number): number {
  const i = wheelIntent(
    { deltaX: 0, deltaY, deltaMode: 0, shiftKey: false, ctrlKey: false, metaKey: false },
    { x: 0, y: 0, width: 1024, height: 512 },
  );
  if (i?.kind !== 'zoom') throw new Error('not a zoom');
  return -Math.log2(i.factor);
}

/** A wheel step about (x, y); the anchor's drift in CSS px. */
function wheelStep(c: Cam, deltaY: number, x: number, y: number, w = 1024, h = 512) {
  const at = fromPx(c, x, y, w, h);
  const next = zoomAbout(c, wheelDz(deltaY), x, y, w, h);
  const p = toPx(next, at.u, at.v, w, h);
  return { next, drift: Math.hypot(p.x - x, p.y - y) };
}

describe('unit:geo-camera', () => {
  it('zoom range and inset', () => {
    expect(zoomRange(160, 120).zMin).toBe(0);
    expect(insetOf(160, 120)).toBe(12);
    expect(zoomRange(1024, 512).zMin).toBe(2);
    expect(zoomRange(300, 600).zMin).toBeCloseTo(1.2288186904958809, 12);
    expect(zoomRange(5e6, 100)).toEqual({ zMin: 14, zMax: 14 });
    expect(insetOf(1024, 512)).toBe(48);
  });

  it('fit: G on 1024 × 512, its bounds; 160 × 120; 5e6 × 100 letterboxed; 4096²; one row on 40 000²', () => {
    const c = fitView(G_PTS, 1024, 512);
    expectView(viewOf(c), ...FIT);
    expect(Math.floor(c.z)).toBe(2);
    const b = boundsOf(c, 1024, 512);
    expect(b.west).toBeCloseTo(-84.97182758620691, 9);
    expect(b.south).toBeCloseTo(-22.432008240607896, 9);
    expect(b.east).toBeCloseTo(148.9658275862069, 9);
    expect(b.north).toBeCloseTo(68.035106748586, 9);
    expectView(viewOf(fitView(G_PTS, 160, 120)), FIT[0], FIT[1], 0);
    expectView(viewOf(fitView(G_PTS, 5e6, 100)), FIT[0], 0, 14);
    expect(fitView(G_PTS, 4096, 4096).z).toBeCloseTo(4.729676096014625, 9);
    const one = G_PTS.slice(0, 1);
    expectView(viewOf(fitView(one, 40_000, 40_000)), 0, 0, 7.28771237954945);
  });

  it('persisted views are raised to zMin and contained', () => {
    const v = camOf({ lat: 50, lon: 5, zoom: 1 });
    expectView(viewOf(contain(v, 1024, 512)), 50, 0, 2);
    expectView(viewOf(contain(v, 5e6, 100)), 50, 0, 14);
  });

  it('wheels: −100 at (10,256) on (0,0,2) with no drift; +100 at (10,10) on (60,−150,3) drifts 281.27 px', () => {
    const a = wheelStep(contain(camOf({ lat: 0, lon: 0, zoom: 2 }), 1024, 512), -100, 10, 256);
    expectView(viewOf(a.next), 0, -31.99118974975306, 2.2885390081777928);
    expect(a.drift).toBeLessThan(EPS);
    const b = wheelStep(contain(camOf({ lat: 60, lon: -150, zoom: 3 }), 1024, 512), 100, 10, 10);
    expectView(viewOf(b.next), 54.85601631006218, -70.07375176558472, 2.7114609918222072);
    expect(b.drift).toBeCloseTo(281.27, 2);
  });

  it('100 anchored steps: every drift < 1e−9, no containment, the final view', () => {
    let c = contain(camOf({ lat: 50, lon: 5, zoom: 4 }), 1024, 512);
    for (let i = 0; i < 100; i++) {
      const s = wheelStep(c, 60 * (-1) ** i, 100 + 8 * i, 100 + 3 * i);
      expect(s.drift, `step ${String(i)}`).toBeLessThan(EPS);
      expect(contain(s.next, 1024, 512)).toEqual(s.next);
      c = s.next;
    }
    expectView(viewOf(c), 48.907393645219365, 9.482311188337547, 4);
  });

  it('a 159 × 200 plot: the zoom range is still defined (tooSmall is the host’s)', () => {
    const r = zoomRange(159, 200);
    expect(Number.isFinite(r.zMin)).toBe(true);
    expect(r.zMax).toBe(14);
    const c = fitView(G_PTS, 159, 200);
    expect(Number.isFinite(c.u) && Number.isFinite(c.v) && Number.isFinite(c.z)).toBe(true);
  });
});

describe('unit:geo-ownership', () => {
  it('refits while following; a commit keeps the camera; only a changed spec view moves it', () => {
    const k = ctlKit({ spec: { motion: 'cut' } });
    expectView(k.ctl.view, ...FIT);
    // Data k05, k06 with no commit: refit.
    k.setData(frameOf(G().filter((s) => s.key === 'k05' || s.key === 'k06')));
    expectView(k.ctl.view, 19.59791091785336, 120.995, 3.971846219329485);
    expect(k.commits).toEqual([]);
    const before = k.ctl.view;
    // Pan +100 px (the content follows the pointer 100 px left), held still before the release.
    pointer(k.canvas, 'pointerdown', 600, 256);
    for (let x = 590; x >= 500; x -= 10) {
      k.clock.advance(10);
      pointer(k.canvas, 'pointermove', x, 256);
    }
    k.clock.advance(100);
    pointer(k.canvas, 'pointerup', 500, 256);
    expect(k.commits.map((c) => c.gesture)).toEqual(['pan']);
    expectView(k.ctl.view, before.lat, 129.95726302107312, before.zoom);
    const panned = k.ctl.view;
    // Data G after the commit: kept.
    k.setData(frameOf());
    expect(k.ctl.view).toEqual(panned);
    // A new title: kept.
    k.setSpec({ title: 'Other' });
    expect(k.ctl.view).toEqual(panned);
    // A changed view: moves.
    k.setSpec({ view: { lat: 10, lon: 10, zoom: 4 } });
    expectView(k.ctl.view, 10, 10, 4);
    // The view equal to the camera: no move, no commit.
    const at = k.ctl.view;
    k.setSpec({ view: { ...at } });
    expect(k.ctl.view).toEqual(at);
    expect(k.commits).toHaveLength(1);
  });

  it('a view set to null refits at once; a resize while following refits', () => {
    const k = ctlKit({ spec: { motion: 'ease', view: { lat: 10, lon: 10, zoom: 4 } } });
    expectView(k.ctl.view, 10, 10, 4);
    k.setSpec({ view: null });
    expectView(k.ctl.view, ...FIT);
    k.ctl.resize(4096, 4096);
    expect(k.ctl.view.zoom).toBeCloseTo(4.729676096014625, 9);
    expect(k.commits).toEqual([]);
  });
});
