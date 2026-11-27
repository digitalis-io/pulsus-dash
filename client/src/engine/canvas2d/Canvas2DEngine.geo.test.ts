/**
 * `unit:geo-scene`, `unit:geo-scene-lifecycle` and `unit:geo-marks-emit` (ADR-0027 (2)–(7), T24
 * §9, T24-091, T24-093; plan #234 Part 2 §3.1, §4.1, §4.6, §5): the Canvas 2D frame's lazy geomap
 * scene, its generation guard and retry, and when `geoMarks` goes out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { colour } from '../../styles/tokens';
import {
  harness,
  LINE_NONE,
  pointer,
  seriesData,
  seriesFrame,
  wheel,
  type Harness,
} from '../../test/engineHarness';
import { frameOf, geoSpec, pxOf } from '../../test/geoKit';
import { G } from '../../vis/geo/fixtures/series';
import type { FrameData, GeoMapSpec, GeoMarksEvent, GeoView } from '../api';
import { camOf, panPx, viewOf } from '../controller/geo/camera';
import { Canvas2DEngine, geoModuleLoader, loadGeoModule, type GeoModule } from './Canvas2DEngine';

const FIT: GeoView = { lat: 33.388480626497824, lon: 31.996999999999986, zoom: 2.6218728064801105 };
const geoData = (f = frameOf()): FrameData => ({ kind: 'geo', geo: f });

/** Every listener added and not removed, per target and type. */
const live = new Map<EventTarget, Map<string, Set<unknown>>>();
type ListenerFn = (
  this: EventTarget,
  type: string,
  fn: EventListenerOrEventListenerObject | null,
  opts?: boolean | AddEventListenerOptions,
) => void;
const proto = EventTarget.prototype as unknown as Record<string, ListenerFn>;
const ADD = Object.getOwnPropertyDescriptor(EventTarget.prototype, 'addEventListener')
  ?.value as ListenerFn;
const REMOVE = Object.getOwnPropertyDescriptor(EventTarget.prototype, 'removeEventListener')
  ?.value as ListenerFn;

beforeEach(() => {
  live.clear();
  proto['addEventListener'] = function (type, fn, opts) {
    let m = live.get(this);
    if (m === undefined) {
      m = new Map<string, Set<unknown>>();
      live.set(this, m);
    }
    let s = m.get(type);
    if (s === undefined) {
      s = new Set();
      m.set(type, s);
    }
    s.add(fn);
    ADD.call(this, type, fn, opts);
  };
  proto['removeEventListener'] = function (type, fn, opts) {
    live.get(this)?.get(type)?.delete(fn);
    REMOVE.call(this, type, fn, opts);
  };
});

afterEach(() => {
  proto['addEventListener'] = ADD;
  proto['removeEventListener'] = REMOVE;
  vi.restoreAllMocks();
});

/** The number of live listeners of each type on `t`, zeros omitted. */
function listeners(t: EventTarget): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [type, s] of live.get(t) ?? []) if (s.size > 0) out[type] = s.size;
  return out;
}

/** What a line frame listens to (one each): its controller's and `contextrestored` (#296). */
const LINE_CANVAS = {
  contextmenu: 1,
  contextrestored: 1,
  dblclick: 1,
  gesturechange: 1,
  gestureend: 1,
  gesturestart: 1,
  lostpointercapture: 1,
  pointercancel: 1,
  pointerdown: 1,
  pointerleave: 1,
  pointermove: 1,
  pointerup: 1,
  wheel: 1,
};
const LINE_KEYS = { focus: 1, focusout: 1, keydown: 1 };

/** The centres of the arcs stroked 2 px in `stroke`. */
function ringCentres(
  ops: readonly { op: string; args: readonly unknown[]; strokeStyle: string; lineWidth: number }[],
  stroke: string,
): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  let arcs: { x: number; y: number }[] = [];
  for (const o of ops) {
    if (o.op === 'beginPath') arcs = [];
    else if (o.op === 'arc') arcs.push({ x: o.args[0] as number, y: o.args[1] as number });
    else if (o.op === 'stroke' && o.strokeStyle === stroke && o.lineWidth === 2) out.push(...arcs);
  }
  return out;
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

interface Deferred {
  load: () => Promise<GeoModule>;
  resolve: (m: GeoModule) => void;
  reject: (e: unknown) => void;
  calls: () => number;
}

function deferred(): Deferred {
  let res: (m: GeoModule) => void = () => undefined;
  let rej: (e: unknown) => void = () => undefined;
  const p = new Promise<GeoModule>((a, b) => {
    res = a;
    rej = b;
  });
  let n = 0;
  return {
    load: () => {
      n += 1;
      return p;
    },
    resolve: (m) => {
      res(m);
    },
    reject: (e) => {
      rej(e);
    },
    calls: () => n,
  };
}

/** The real module with a counted `createGeoScene`. */
async function counted(): Promise<GeoModule & { created: () => number }> {
  const real = await loadGeoModule();
  let n = 0;
  return {
    ...real,
    createGeoScene: (d) => {
      n += 1;
      return real.createGeoScene(d);
    },
    created: () => n,
  };
}

interface GeoHarness extends Harness {
  readonly keyTarget: HTMLElement;
  readonly marks: GeoMarksEvent[];
  readonly geoEvents: string[];
}

function geoHarness(load: () => Promise<GeoModule>): GeoHarness {
  const keyTarget = document.createElement('div');
  document.body.append(keyTarget);
  const h = harness(Canvas2DEngine, { keyTarget, loadGeo: load, clockNow: true });
  const marks: GeoMarksEvent[] = [];
  const geoEvents: string[] = [];
  h.frame.on('geoMarks', (m) => {
    marks.push(m);
    geoEvents.push('geoMarks');
  });
  h.frame.on('geoCommit', () => geoEvents.push('geoCommit'));
  h.frame.on('geoBrush', () => geoEvents.push('geoBrush'));
  return Object.assign(h, { keyTarget, marks, geoEvents });
}

/** A geomap frame on G at fit, 1024 × 512, drawn. */
async function atFit(spec: Partial<GeoMapSpec> = { motion: 'cut' }): Promise<GeoHarness> {
  const mod = await loadGeoModule();
  const h = geoHarness(() => Promise.resolve(mod));
  h.frame.setSpec(geoSpec(spec));
  h.frame.setData(geoData());
  h.frame.resize(1024, 512, 1);
  await settle();
  h.flush();
  return h;
}

describe('unit:geo-scene-lifecycle', () => {
  it('(a) geomap, then line, then the load resolves: no scene, no geo listener, no event', async () => {
    const d = deferred();
    const h = geoHarness(d.load);
    h.frame.setSpec(geoSpec());
    h.frame.setData(geoData());
    h.frame.resize(1024, 512, 1);
    h.flush();
    h.frame.setSpec(LINE_NONE);
    h.frame.setData(seriesData(seriesFrame('00000000000000a1', [0, 1000], [1, 2])));
    h.frame.setTimeWindow({ fromMs: 0, toMs: 1000 });
    const mod = await counted();
    d.resolve(mod);
    await settle();
    h.flush();
    expect(d.calls()).toBe(1);
    expect(mod.created()).toBe(0);
    expect(listeners(h.canvas)).toEqual(LINE_CANVAS);
    expect(listeners(h.keyTarget)).toEqual(LINE_KEYS);
    expect(h.geoEvents).toEqual([]);
  });

  it('(b) geomap, then dispose, then the load resolves: no scene, no listener, no event', async () => {
    const d = deferred();
    const h = geoHarness(d.load);
    h.frame.setSpec(geoSpec());
    h.frame.setData(geoData());
    h.frame.resize(1024, 512, 1);
    h.frame.dispose();
    const mod = await counted();
    d.resolve(mod);
    await settle();
    h.flush();
    expect(d.calls()).toBe(1);
    expect(mod.created()).toBe(0);
    expect(listeners(h.canvas)).toEqual({});
    expect(listeners(h.keyTarget)).toEqual({});
    expect(h.geoEvents).toEqual([]);
    expect(h.drawn).toEqual([]);
  });

  it('(c) a rejected import is not kept: a new frame imports again and draws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const mod = await loadGeoModule();
    const imp = vi
      .fn<() => Promise<GeoModule>>()
      .mockImplementationOnce(() => Promise.reject(new Error('chunk failed')))
      .mockImplementation(() => Promise.resolve(mod));
    const load = geoModuleLoader(imp);
    const a = geoHarness(load);
    a.frame.setSpec(geoSpec());
    a.frame.setData(geoData());
    a.frame.resize(1024, 512, 1);
    await settle();
    a.flush();
    expect(a.drawn).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    const b = geoHarness(load);
    b.frame.setSpec(geoSpec());
    b.frame.setData(geoData());
    b.frame.resize(1024, 512, 1);
    await settle();
    b.flush();
    expect(imp).toHaveBeenCalledTimes(2);
    expect(b.drawn.length).toBeGreaterThan(0);
    // The value is kept once loaded: no third import.
    void load();
    expect(imp).toHaveBeenCalledTimes(2);
  });

  it('a camera key before the scene is ready is a no-op; after it, it moves the map', async () => {
    const d = deferred();
    const h = geoHarness(d.load);
    h.frame.setSpec(geoSpec({ motion: 'cut' }));
    h.frame.setData(geoData());
    expect(() => {
      h.frame.cameraKey('in');
    }).not.toThrow();
    d.resolve(await loadGeoModule());
    await settle();
    // Attached, but no size yet: still a no-op.
    h.frame.cameraKey('in');
    h.frame.resize(1024, 512, 1);
    h.flush();
    expect(h.geoEvents).toEqual(['geoMarks']);
    expect(Math.abs((h.a11y.at(-1)?.geo?.view.zoom ?? 0) - FIT.zoom)).toBeLessThan(1e-9);
    h.frame.cameraKey('in');
    h.flush();
    expect(h.geoEvents).toEqual(['geoMarks', 'geoCommit', 'geoMarks']);
    expect(Math.abs((h.a11y.at(-1)?.geo?.view.zoom ?? 0) - (FIT.zoom + 1))).toBeLessThan(1e-9);
  });

  it('until the module resolves the frame paints map-water and emits no drawn', () => {
    const d = deferred();
    const h = geoHarness(d.load);
    h.frame.setSpec(geoSpec());
    h.frame.resize(1024, 512, 1);
    h.flush();
    expect(h.drawn).toEqual([]);
    expect(h.visible().calls('fillRect').at(-1)?.fillStyle).toBe(colour.dark['map-water']);
    expect(d.calls()).toBe(1);
  });
});

describe('unit:geo-scene', () => {
  it('creates the scene, draws, reports the summary and geoMarks once; ignores the time window; a line disposes it', async () => {
    const mod = await counted();
    const h = geoHarness(() => Promise.resolve(mod));
    h.frame.setSpec(geoSpec({ motion: 'cut' }));
    h.frame.setData(geoData());
    h.frame.resize(1024, 512, 1);
    await settle();
    h.flush();
    expect(mod.created()).toBe(1);
    expect(h.drawn.length).toBeGreaterThan(0);
    const s = h.a11y.at(-1);
    expect(s?.kind).toBe('geomap');
    const g = s?.geo;
    expect(g?.level).toBe(2);
    expect(g?.marks).toBe(5);
    expect(g?.clusters).toBe(2);
    expect(Math.abs((g?.view.lat ?? 0) - FIT.lat)).toBeLessThan(1e-9);
    expect(Math.abs((g?.view.lon ?? 0) - FIT.lon)).toBeLessThan(1e-9);
    expect(Math.abs((g?.view.zoom ?? 0) - FIT.zoom)).toBeLessThan(1e-9);
    expect(s?.seriesTotal).toBe(18);
    expect(s?.seriesShown).toBe(10);
    expect(s?.min).toBe(-30);
    expect(s?.max).toBe(300);
    expect(s?.plot).toEqual({ x: 0, y: 0, width: 1024, height: 512 });
    expect(h.marks).toHaveLength(1);
    expect(h.marks[0]?.level).toBe(2);
    expect(h.marks[0]?.marks.map((m) => m.id)).toEqual([
      'cluster:k03',
      'cluster:k07',
      'k05',
      'k06',
      'k14',
    ]);
    // The geo listeners are the scene's, not the time camera's.
    expect(listeners(h.canvas)['gesturestart']).toBeUndefined();
    expect(listeners(h.canvas)['wheel']).toBe(1);
    const drawn = h.drawn.length;
    h.frame.setTimeWindow({ fromMs: 0, toMs: 1 });
    h.frame.setEvents([{ id: 'e', atMs: 0, endMs: null, kind: 'deploy', title: 'x' }]);
    h.flush();
    expect(h.drawn.length).toBe(drawn);
    h.frame.setSpec(LINE_NONE);
    expect(listeners(h.canvas)).toEqual(LINE_CANVAS);
    expect(listeners(h.keyTarget)).toEqual(LINE_KEYS);
  });

  it('a frame set up before the load replays its spec, data, theme, size, selection and focus mark', async () => {
    const d = deferred();
    const h = geoHarness(d.load);
    h.frame.setSpec(geoSpec({ motion: 'cut' }));
    h.frame.setData(geoData());
    h.frame.setTheme('light');
    h.frame.resize(1024, 512, 1);
    h.frame.setSelection({ keys: ['k05'], fromMs: null, toMs: null });
    h.frame.setFocusMark('k06');
    h.flush();
    d.resolve(await loadGeoModule());
    await settle();
    h.flush();
    expect(h.a11y.at(-1)?.geo?.marks).toBe(5);
    const ops = h.visible().ops;
    // Light map water.
    expect(ops.some((o) => o.op === 'fillRect' && o.fillStyle === colour.light['map-water'])).toBe(
      true,
    );
    // The selection ring on k05 and the focus ring on k06 (2 px, `focus`).
    const at = (key: string) => pxOf(frameOf(), key, FIT);
    const rings = ringCentres(ops, colour.light.focus);
    const near = (key: string) =>
      rings.some((r) => Math.abs(r.x - at(key).x) < 0.01 && Math.abs(r.y - at(key).y) < 0.01);
    expect(near('k05')).toBe(true);
    expect(near('k06')).toBe(true);
    // Other marks dimmed.
    expect(ops.some((o) => o.op === 'fill' && o.globalAlpha === 0.35)).toBe(true);
  });

  it('dispose: no event after it', async () => {
    const h = await atFit();
    const n = { hover: h.hover.length, select: h.select.length, drawn: h.drawn.length };
    h.frame.dispose();
    pointer(h.canvas, 'pointermove', 389, 154);
    pointer(h.canvas, 'pointerdown', 389, 154);
    pointer(h.canvas, 'pointerup', 389, 154);
    h.advance(1000);
    h.flush();
    expect({ hover: h.hover.length, select: h.select.length, drawn: h.drawn.length }).toEqual(n);
    expect(h.geoEvents).toEqual(['geoMarks']);
    expect(listeners(h.canvas)).toEqual({});
    expect(listeners(h.keyTarget)).toEqual({});
  });

  it('the chart-draw measure is tagged geomap with the marks', async () => {
    const measures: { name: string; detail: unknown }[] = [];
    vi.spyOn(performance, 'measure').mockImplementation(((
      name: string,
      o: { detail?: unknown },
    ) => {
      measures.push({ name, detail: o.detail });
      return undefined;
    }) as unknown as typeof performance.measure);
    await atFit();
    expect(measures.at(-1)).toEqual({
      name: 'chart-draw',
      detail: { kind: 'geomap', series: 5, frame: null },
    });
  });
});

describe('unit:geo-marks-emit', () => {
  const ids = (m: GeoMarksEvent | undefined) => m?.marks.map((x) => [x.id, x.inView]);

  it('(a) a redraw with nothing changed emits nothing', async () => {
    const h = await atFit();
    expect(h.marks).toHaveLength(1);
    h.frame.setTheme('dark');
    h.flush();
    expect(h.drawn.length).toBeGreaterThan(1);
    expect(h.marks).toHaveLength(1);
  });

  it('(b) a spec view at the same level moving k06 (and k14, below it) out of view: one, with their inView false', async () => {
    const h = await atFit();
    // The content 110 px down: k06 (y 405.29) and k14 (411.20) leave the 512 px plot.
    const at = pxOf(frameOf(), 'k06', FIT);
    expect(at.y).toBeCloseTo(405.29, 2);
    const view = viewOf(panPx(camOf(FIT), 0, -110, 1024, 512));
    h.frame.setSpec(geoSpec({ motion: 'cut', view }));
    h.flush();
    expect(h.marks).toHaveLength(2);
    const m = h.marks[1];
    expect(m?.level).toBe(2);
    expect(ids(m)).toEqual([
      ['cluster:k03', true],
      ['cluster:k07', true],
      ['k05', true],
      ['k06', false],
      ['k14', false],
    ]);
  });

  it('(c) a resize to 600 × 512: one, inView per the new plot', async () => {
    const h = await atFit();
    h.frame.resize(600, 512, 1);
    h.flush();
    expect(h.marks).toHaveLength(2);
    const view = h.a11y.at(-1)?.geo?.view ?? FIT;
    const m = h.marks[1];
    for (const x of m?.marks ?? []) {
      const key = x.kind === 'cluster' ? x.id.slice('cluster:'.length) : x.id;
      const p = pxOf(frameOf(), key, view, 600, 512);
      expect(x.inView, x.id).toBe(p.x >= 0 && p.x <= 600 && p.y >= 0 && p.y <= 512);
    }
  });

  it('(d) cluster:false: one, with 9 marks and cluster:k07 only', async () => {
    const h = await atFit();
    h.frame.setSpec(geoSpec({ motion: 'cut', cluster: false }));
    h.flush();
    expect(h.marks).toHaveLength(2);
    expect(h.marks[1]?.marks).toHaveLength(9);
    expect(h.marks[1]?.marks.filter((x) => x.kind === 'cluster').map((x) => x.id)).toEqual([
      'cluster:k07',
    ]);
  });

  it('(e) a small pan commit keeping every mark in view: exactly one, after the commit, unchanged', async () => {
    const h = await atFit();
    const order: string[] = [];
    h.frame.on('geoCommit', () => order.push('commit'));
    h.frame.on('geoMarks', () => order.push('marks'));
    pointer(h.canvas, 'pointerdown', 500, 256);
    h.advance(10);
    pointer(h.canvas, 'pointermove', 505, 256);
    h.flush();
    h.advance(200);
    pointer(h.canvas, 'pointerup', 505, 256);
    h.flush();
    expect(order).toEqual(['commit', 'marks']);
    expect(h.marks).toHaveLength(2);
    expect(h.marks[1]).toEqual(h.marks[0]);
  });

  it('(g) a wheel commit at idle, after its last draw: one geoMarks, and a draw follows', async () => {
    const h = await atFit();
    wheel(h.canvas, 512, 256, { deltaX: 20, ctrlKey: false });
    h.flush();
    const drawn = h.drawn.length;
    const marks = h.marks.length;
    h.advance(300);
    expect(h.geoEvents.slice(-2)).toEqual(['geoCommit', 'geoMarks']);
    expect(h.marks).toHaveLength(marks + 1);
    expect(h.queued()).toBeGreaterThan(0);
    h.flush();
    expect(h.drawn.length).toBeGreaterThan(drawn);
    expect(h.marks).toHaveLength(marks + 1);
  });

  it('(h) two commits before a draw: two geoMarks', async () => {
    const h = await atFit();
    const marks = h.marks.length;
    h.frame.cameraKey('panLeft');
    h.frame.cameraKey('panDown');
    expect(h.geoEvents.slice(-4)).toEqual(['geoCommit', 'geoMarks', 'geoCommit', 'geoMarks']);
    h.flush();
    expect(h.marks).toHaveLength(marks + 2);
  });

  it('(f) setData with an equal copy of G: exactly one, unchanged', async () => {
    const h = await atFit();
    h.frame.setData(geoData(frameOf(G(), { seq: 2 })));
    h.flush();
    expect(h.marks).toHaveLength(2);
    expect(h.marks[1]).toEqual(h.marks[0]);
  });
});

describe('unit:geo-render-failed (the producer, plan #234 Part 3 §4.4a)', () => {
  it('(a) a rejected scene import for the live geomap: exactly one a11y {kind: geomap, geo: null}, no drawn; (b) after a line spec or dispose: none', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const d = deferred();
    const h = geoHarness(d.load);
    h.frame.setSpec(geoSpec());
    h.frame.setData(geoData());
    h.frame.resize(1024, 512, 1);
    h.flush();
    const before = h.a11y.length;
    d.reject(new Error('chunk failed'));
    await settle();
    h.flush();
    const failed = h.a11y.slice(before);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.kind).toBe('geomap');
    expect(failed[0]?.geo).toBeNull();
    expect(h.drawn).toEqual([]);
    // Nothing more on later frames.
    h.frame.setSelection({ keys: ['k01'], fromMs: null, toMs: null });
    h.flush();
    expect(h.a11y.slice(before)).toHaveLength(1);
    // (b) setSpec(line) or dispose before the rejection: no summary.
    for (const leave of ['line', 'dispose'] as const) {
      const d = deferred();
      const h = geoHarness(d.load);
      h.frame.setSpec(geoSpec());
      h.frame.setData(geoData());
      h.frame.resize(1024, 512, 1);
      h.flush();
      if (leave === 'line') {
        h.frame.setSpec(LINE_NONE);
        h.frame.setData(seriesData(seriesFrame('00000000000000a1', [0, 1000], [1, 2])));
      } else {
        h.frame.dispose();
      }
      const n = h.a11y.length;
      d.reject(new Error('chunk failed'));
      await settle();
      h.flush();
      expect(h.a11y.slice(n).filter((s) => s.kind === 'geomap')).toEqual([]);
    }
  });
});
