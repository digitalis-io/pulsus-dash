/**
 * `unit:geo-keys-engine`, `unit:geo-inertia` and `unit:geo-ease-origin` (T24 §10.4, T24-091,
 * INT-003, INT-004, VL-016; plan #234 Part 2 §4.3, §4.4, §5): the camera keys, the wheel pan, the
 * T02 inertia of a fling and what an interruption commits.
 */
import { describe, expect, it } from 'vitest';
import { key, pointer, wheel } from '../../../test/engineHarness';
import { ctlKit, frameOf, pxOf, type CtlKit } from '../../../test/geoKit';
import { G } from '../../../vis/geo/fixtures/series';
import type { GeoView } from '../../api';
import { spring } from '../inertia';
import { camOf } from './camera';
import { worldPx } from './project';

const FIT: GeoView = { lat: 33.388480626497824, lon: 31.996999999999986, zoom: 2.6218728064801105 };

function close(a: GeoView, b: GeoView, eps = 1e-9): void {
  expect(Math.abs(a.lat - b.lat), 'lat').toBeLessThan(eps);
  expect(Math.abs(a.lon - b.lon), 'lon').toBeLessThan(eps);
  expect(Math.abs(a.zoom - b.zoom), 'zoom').toBeLessThan(eps);
}

/** The centre's world x, CSS px at the view's own zoom. */
const centreX = (v: GeoView): number => camOf(v).u * worldPx(v.zoom);

/** A left drag from (500,256) moving +10 px every 10 ms for 100 ms, released while moving. */
function fling(k: CtlKit): void {
  pointer(k.canvas, 'pointerdown', 500, 256);
  for (let i = 1; i <= 10; i++) {
    k.clock.advance(10);
    pointer(k.canvas, 'pointermove', 500 + 10 * i, 256);
  }
  pointer(k.canvas, 'pointerup', 600, 256);
}

describe('unit:geo-keys-engine', () => {
  const keys = (o: { focus?: boolean } = {}) => {
    const k = ctlKit({ spec: { motion: 'cut' } });
    if (o.focus !== false) k.ctl.setFocusMark('k05');
    return k;
  };

  it('+ zooms ×2 about the focus mark k05, which stays put; one keys commit', () => {
    const k = keys();
    const at = pxOf(k.frame, 'k05', k.ctl.view);
    const e = key(k.keyTarget, '+');
    expect(e.defaultPrevented).toBe(true);
    expect(k.ctl.view.zoom).toBeCloseTo(3.6218728064801105, 12);
    const after = pxOf(k.frame, 'k05', k.ctl.view);
    expect(Math.abs(after.x - at.x) + Math.abs(after.y - at.y)).toBeLessThan(1e-6);
    expect(k.commits.map((c) => c.gesture)).toEqual(['keys']);
  });

  it('+ then − returns to the fit zoom; = is +', () => {
    const k = keys();
    key(k.keyTarget, '=');
    key(k.keyTarget, '-');
    expect(k.ctl.view.zoom).toBeCloseTo(2.6218728064801105, 12);
    expect(k.commits.map((c) => c.gesture)).toEqual(['keys', 'keys']);
  });

  it('0 fits after a zoom with one fit commit; from fit it moves nothing and commits nothing', () => {
    const k = keys();
    key(k.keyTarget, '0');
    close(k.ctl.view, FIT);
    expect(k.commits).toEqual([]);
    key(k.keyTarget, '+');
    key(k.keyTarget, '0');
    close(k.ctl.view, FIT);
    expect(k.commits.map((c) => c.gesture)).toEqual(['keys', 'fit']);
    close(k.commits[1]?.view ?? FIT, FIT);
  });

  it('no commit when the view does not move: zoom in at 14, a pan held by containment', () => {
    const k = ctlKit({ spec: { motion: 'cut', view: { lat: 10, lon: 10, zoom: 14 } } });
    const v = k.ctl.view;
    key(k.keyTarget, '+');
    expect(k.ctl.view).toEqual(v);
    // Already at the east edge: Shift+→ stays put.
    const f = keys();
    key(f.keyTarget, 'ArrowRight', { shiftKey: true });
    expect(f.commits).toHaveLength(1);
    const edge = f.ctl.view;
    key(f.keyTarget, 'ArrowRight', { shiftKey: true });
    expect(f.ctl.view).toEqual(edge);
    expect(f.commits).toHaveLength(1);
    expect(k.commits).toEqual([]);
  });

  it('a data-following camera keeps following after a key that moved nothing', () => {
    const k = keys({ focus: false });
    key(k.keyTarget, '0');
    k.setData(frameOf(G().filter((s) => s.key === 'k05' || s.key === 'k06')));
    expect(k.ctl.view.lon).toBeCloseTo(120.995, 9);
    expect(k.commits).toEqual([]);
  });

  it('Shift+← moves the centre −256 px, Shift+↓ +128 px; Shift+→ stops at the world edge', () => {
    const k = keys();
    const x0 = centreX(k.ctl.view);
    key(k.keyTarget, 'ArrowLeft', { shiftKey: true });
    expect(centreX(k.ctl.view) - x0).toBeCloseTo(-256, 6);
    const y0 = camOf(k.ctl.view).v * worldPx(k.ctl.view.zoom);
    key(k.keyTarget, 'ArrowDown', { shiftKey: true });
    expect(camOf(k.ctl.view).v * worldPx(k.ctl.view.zoom) - y0).toBeCloseTo(128, 6);
    expect(k.commits.map((c) => c.gesture)).toEqual(['keys', 'keys']);
    // At fit the east edge is 135.84 px away: containment (T24-091) caps the 256 px pan there.
    const f = keys();
    key(f.keyTarget, 'ArrowRight', { shiftKey: true });
    const S = worldPx(f.ctl.view.zoom);
    expect(centreX(f.ctl.view)).toBeCloseTo(S - 512, 6);
    expect(centreX(f.ctl.view) - x0).toBeCloseTo(135.84385347584475, 6);
  });

  it('a wheel deltaX 100 pans to lon 54.84247413793099 and commits wheel after 300 ms idle', () => {
    const k = keys();
    const e = wheel(k.canvas, 512, 256, { deltaX: 100, ctrlKey: false });
    expect(e.defaultPrevented).toBe(true);
    expect(k.ctl.view.lon).toBeCloseTo(54.84247413793099, 9);
    expect(k.commits).toEqual([]);
    k.clock.advance(300);
    expect(k.commits.map((c) => c.gesture)).toEqual(['wheel']);
  });

  it('a null wheel, modified keys and a keydown from another element change nothing', () => {
    const k = keys();
    const v = k.ctl.view;
    const e = wheel(k.canvas, 512, 256, { ctrlKey: false });
    expect(e.defaultPrevented).toBe(false);
    const child = document.createElement('button');
    k.keyTarget.append(child);
    expect(key(child, '+').defaultPrevented).toBe(false);
    expect(key(k.keyTarget, '+', { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(key(k.keyTarget, 'ArrowRight').defaultPrevented).toBe(false);
    k.clock.advance(1000);
    expect(k.ctl.view).toEqual(v);
    expect(k.commits).toEqual([]);
  });

  it('wheelZoom false: the wheel is not taken (the page scrolls)', () => {
    const k = ctlKit({ spec: { motion: 'cut', wheelZoom: false } });
    const v = k.ctl.view;
    expect(wheel(k.canvas, 512, 256, { deltaY: 100, ctrlKey: false }).defaultPrevented).toBe(false);
    expect(k.ctl.view).toEqual(v);
  });

  it('cameraKey matches the surface keys; the focus mark out of view anchors at the centre', () => {
    const k = keys({ focus: false });
    k.ctl.cameraKey('in');
    // No focus mark: about the centre, so the centre stays.
    expect(k.ctl.view.lon).toBeCloseTo(FIT.lon, 9);
    expect(k.ctl.view.zoom).toBeCloseTo(3.6218728064801105, 12);
    expect(k.commits.map((c) => c.gesture)).toEqual(['keys']);
  });
});

describe('unit:geo-inertia', () => {
  it('the spring: monotone, no overshoot, settled in 300 ± 50 ms at D = 2v/ω', () => {
    const D = 2 / 0.0194;
    let prev = 0;
    let doneAt = -1;
    for (let t = 0; t <= 400; t += 1) {
      const s = spring(1, t);
      expect(s.offset).toBeGreaterThanOrEqual(prev);
      expect(s.offset).toBeLessThanOrEqual(D + 1e-9);
      prev = s.offset;
      if (s.done && doneAt < 0) doneAt = t;
    }
    expect(doneAt).toBeGreaterThanOrEqual(250);
    expect(doneAt).toBeLessThanOrEqual(350);
    expect(spring(1, doneAt).offset).toBeCloseTo(D, 9);
    expect(spring(-1, doneAt).offset).toBeCloseTo(-D, 9);
  });

  it('a fling keeps panning, settles in 300 ± 50 ms with no overshoot and commits pan once', () => {
    const k = ctlKit();
    fling(k);
    const release = k.ctl.view;
    expect(k.commits).toEqual([]);
    let prev = release.lon;
    let t = 0;
    let moving = true;
    while (moving && t < 1000) {
      k.clock.advance(16);
      t += 16;
      moving = k.ctl.tick(k.clock.now());
      // The content follows the pointer right: the centre moves west, monotonically.
      expect(k.ctl.view.lon).toBeLessThanOrEqual(prev);
      prev = k.ctl.view.lon;
      if (moving) expect(k.commits).toEqual([]);
    }
    expect(release.lon - k.ctl.view.lon).toBeGreaterThan(0);
    expect(t).toBeGreaterThanOrEqual(250);
    expect(t).toBeLessThanOrEqual(350 + 16);
    expect(k.commits.map((c) => c.gesture)).toEqual(['pan']);
    // D = 2v/ω at 1 px/ms.
    const moved = centreX(release) - centreX(k.ctl.view);
    expect(moved).toBeCloseTo(2 / 0.0194, 6);
    expect(k.run(200)).toBe(false);
    expect(k.commits).toHaveLength(1);
  });

  it('a pointer-down during the decay stops it there; the gesture still commits once', () => {
    const k = ctlKit();
    fling(k);
    k.run(100);
    pointer(k.canvas, 'pointerdown', 300, 300);
    const stopped = k.ctl.view;
    expect(k.commits.map((c) => c.gesture)).toEqual(['pan']);
    close(k.commits[0]?.view ?? FIT, stopped);
    k.clock.advance(16);
    expect(k.ctl.tick(k.clock.now())).toBe(false);
    expect(k.ctl.view).toEqual(stopped);
    pointer(k.canvas, 'pointerup', 300, 300);
    expect(k.commits).toHaveLength(1);
  });

  it('reduced motion: a fling lands at its end offset at once, one pan commit, no later move', () => {
    const eased = ctlKit();
    fling(eased);
    eased.run(1000);
    const k = ctlKit({ spec: { motion: 'cut' } });
    fling(k);
    close(k.ctl.view, eased.ctl.view);
    expect(k.commits.map((c) => c.gesture)).toEqual(['pan']);
    const v = k.ctl.view;
    expect(k.run(400)).toBe(false);
    expect(k.ctl.view).toEqual(v);
    expect(k.commits).toHaveLength(1);
  });

  it('a camera key during the decay: inertia stops (pan), then the zoom eases from there (keys)', () => {
    const k = ctlKit();
    fling(k);
    k.run(100);
    k.ctl.cameraKey('in');
    expect(k.commits.map((c) => c.gesture)).toEqual(['pan']);
    const from = k.commits[0]?.view ?? FIT;
    k.run(400);
    expect(k.commits.map((c) => c.gesture)).toEqual(['pan', 'keys']);
    expect(k.ctl.view.zoom).toBeCloseTo(from.zoom + 1, 9);
  });
});

describe('unit:geo-ease-origin', () => {
  const SPEC_VIEW: GeoView = { lat: 10, lon: 10, zoom: 4 };

  it('a spec ease stopped by a pointer-down commits nothing', () => {
    const k = ctlKit();
    k.setSpec({ view: SPEC_VIEW });
    k.run(100);
    const mid = k.ctl.view;
    expect(mid.zoom).toBeGreaterThan(FIT.zoom);
    expect(mid.zoom).toBeLessThan(4);
    pointer(k.canvas, 'pointerdown', 512, 256);
    expect(k.ctl.view).toEqual(mid);
    pointer(k.canvas, 'pointerup', 512, 256);
    expect(k.run(400)).toBe(false);
    expect(k.ctl.view).toEqual(mid);
    expect(k.commits).toEqual([]);
  });

  it('a spec ease stopped by a wheel commits nothing; the wheel commits its own', () => {
    const k = ctlKit();
    k.setSpec({ view: SPEC_VIEW });
    k.run(100);
    const mid = k.ctl.view;
    wheel(k.canvas, 512, 256, { deltaY: -100, ctrlKey: false });
    expect(k.commits).toEqual([]);
    expect(k.ctl.view.zoom).toBeCloseTo(mid.zoom + 0.2885390081777928, 9);
    k.clock.advance(300);
    expect(k.commits.map((c) => c.gesture)).toEqual(['wheel']);
  });

  it('a + key ease stopped by a pointer-down commits keys once, at its stop pose', () => {
    const k = ctlKit();
    key(k.keyTarget, '+');
    k.run(100);
    pointer(k.canvas, 'pointerdown', 512, 256);
    const stop = k.ctl.view;
    expect(stop.zoom).toBeGreaterThan(FIT.zoom);
    expect(stop.zoom).toBeLessThan(FIT.zoom + 1);
    expect(k.commits.map((c) => c.gesture)).toEqual(['keys']);
    close(k.commits[0]?.view ?? FIT, stop);
    pointer(k.canvas, 'pointerup', 512, 256);
    k.run(400);
    expect(k.commits).toHaveLength(1);
  });

  it('an ease stopped before it moves commits nothing', () => {
    const k = ctlKit();
    key(k.keyTarget, '+');
    // No frame has advanced it: the pose is still the start.
    pointer(k.canvas, 'pointerdown', 512, 256);
    pointer(k.canvas, 'pointerup', 512, 256);
    close(k.ctl.view, FIT);
    expect(k.run(400)).toBe(false);
    expect(k.commits).toEqual([]);
  });

  it('a key ease runs 200 ms and commits at its end', () => {
    const k = ctlKit();
    key(k.keyTarget, '+');
    k.run(150);
    expect(k.commits).toEqual([]);
    k.run(100);
    expect(k.commits.map((c) => c.gesture)).toEqual(['keys']);
    expect(k.ctl.view.zoom).toBeCloseTo(FIT.zoom + 1, 9);
  });
});
