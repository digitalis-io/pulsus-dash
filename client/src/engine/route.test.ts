import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeEngine, type FakeEngine, type FakeFrame } from '../test/fakeEngine';
import type { FrameData, FrameEvents, FrameInit, VisSpec } from './api';
import { RoutingEngine, type WasmBackend } from './route';
import type { EngineFrame } from './wasm/frame';

const LINE_A: VisSpec = { kind: 'line', title: 'A', unit: { kind: 'none' } };
const LINE_B: VisSpec = { kind: 'line', title: 'B', unit: { kind: 'none' } };
const BARS: VisSpec = {
  kind: 'bars',
  title: 'C',
  unit: { kind: 'none' },
  stacking: 'normal',
  categoryLabel: 'level',
  categoryOrder: [],
};
const GEO: VisSpec = {
  kind: 'geomap',
  title: 'Map',
  unit: { kind: 'none' },
  view: null,
  motion: 'ease',
  size: { by: 'value', min: 4, max: 20 },
  colour: 'group',
  symbol: 'circle',
  labels: 'auto',
  cluster: true,
  wheelZoom: true,
};
const D: FrameData = {
  kind: 'series',
  series: [
    {
      key: '00000000000000a1',
      labels: {},
      timestamps: new Float64Array([1, 2]),
      values: new Float64Array([3, 4]),
    },
  ],
};
const W = { fromMs: 1, toMs: 2 };
const INIT: FrameInit = { timeZone: 'UTC', keyTarget: null, id: 'f1' };

interface Backend extends WasmBackend {
  readonly inner: FakeEngine;
  readonly fails: ((reason: string) => void)[];
}

/** A T1 backend whose frames are fake frames (the offscreen canvas is recorded, not drawn). */
function backend(): Backend {
  const inner = fakeEngine();
  const fails: ((reason: string) => void)[] = [];
  return {
    tier: 't1',
    inner,
    fails,
    createFrame(canvas: OffscreenCanvas, init: FrameInit, onFail): EngineFrame {
      fails.push(onFail);
      return inner.createFrame(canvas as unknown as HTMLCanvasElement, init) as FakeFrame;
    },
  };
}

let transfers = 0;
beforeEach(() => {
  transfers = 0;
  Object.defineProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen', {
    configurable: true,
    value(this: HTMLCanvasElement) {
      transfers += 1;
      return { width: 0, height: 0 } as unknown as OffscreenCanvas;
    },
  });
});
afterEach(() => {
  Reflect.deleteProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen');
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

const methods = (f: FakeFrame): string[] => f.calls.map((c) => c.method);

describe('RoutingEngine (D-ROUTE)', () => {
  it('a line frame binds to the engine after boot and replays the latest state once, in order (C2a2: the window as a camera)', async () => {
    const b = backend();
    const c2d = fakeEngine();
    const e = new RoutingEngine(() => Promise.resolve(b), c2d);
    const canvas = document.createElement('canvas');
    const f = e.createFrame(canvas, INIT);
    f.setSpec(LINE_A);
    f.setSpec(LINE_B);
    f.setData(D);
    f.setTimeWindow(W);
    f.setTheme('light');
    f.resize(300, 150, 1);
    expect(b.inner.frames).toHaveLength(0);
    await flush();
    expect(b.inner.frames).toHaveLength(1);
    const inner = b.inner.frames[0];
    if (inner === undefined) throw new Error('not bound');
    // The controller sends the window as the engine camera (plan #68 C2a2 §3.2): on the window,
    // and again on every later layout input; each layout input also clears the hover with an
    // Overlay, flushed before the call (plan #68 C2b §4.1).
    const camera = {
      method: 'setCamera',
      args: [{ view: { lo: 1, hi: 2 }, value: null, band: null }],
    };
    const none = { method: 'setOverlay', args: [{ hover: { kind: 'none' }, box: null }] };
    expect(inner.calls).toEqual([
      none,
      { method: 'setSpec', args: [LINE_B] },
      none,
      { method: 'setData', args: [D] },
      camera,
      none,
      camera,
      none,
      { method: 'setTheme', args: ['light'] },
      { method: 'setEvents', args: [[]] },
      { method: 'setSelection', args: [null] },
      camera,
      none,
      { method: 'resize', args: [300, 150, 1] },
    ]);
    expect(transfers).toBe(1);
    expect(canvas.dataset['engine']).toBe('wasm-webgpu');
    expect(c2d.frames).toHaveLength(0);
    // Events from the bound frame reach the listeners.
    const seen: number[] = [];
    f.on('drawn', (d) => seen.push(d.cssWidth));
    inner.draw();
    expect(seen).toEqual([300]);
  });

  it('a kind swap moves an engine frame to Canvas 2D on a fresh canvas, for good', async () => {
    const b = backend();
    const c2d = fakeEngine();
    const e = new RoutingEngine(() => Promise.resolve(b), c2d);
    const host = document.createElement('div');
    const canvas = document.createElement('canvas');
    host.append(canvas);
    const f = e.createFrame(canvas, INIT);
    f.setSpec(LINE_A);
    f.setData(D);
    f.resize(300, 150, 1);
    await flush();
    const inner = b.inner.frames[0];
    if (inner === undefined) throw new Error('not bound');
    f.setSpec(BARS);
    expect(inner.disposed).toBe(1);
    expect(inner.last('setSpec')).toEqual([LINE_A]);
    const live = host.querySelectorAll('canvas')[1];
    expect(c2d.createCalls.map((c) => c.canvas)).toEqual([live]);
    expect(live?.dataset['engine']).toBe('canvas2d');
    expect(canvas.hasAttribute('data-retired')).toBe(true);
    expect(c2d.frames[0]?.calls.map((c) => c.method)).toEqual([
      'setSpec',
      'setData',
      'setEvents',
      'setSelection',
      'resize',
    ]);
    expect(c2d.frames[0]?.last('setSpec')).toEqual([BARS]);
    expect(host.querySelector('[data-engine-notice]')).toBeNull();
    // Back to a line: it stays on Canvas 2D, with no second transfer.
    f.setSpec(LINE_B);
    await flush();
    expect(c2d.frames[0]?.last('setSpec')).toEqual([LINE_B]);
    expect(b.inner.frames).toHaveLength(1);
    expect(transfers).toBe(1);
  });

  it('a non-line frame goes to Canvas 2D at once, on the same canvas', () => {
    const load = vi.fn(() => Promise.resolve(backend()));
    const c2d = fakeEngine();
    const e = new RoutingEngine(load, c2d);
    const canvas = document.createElement('canvas');
    const f = e.createFrame(canvas, INIT);
    f.setSpec(BARS);
    expect(c2d.createCalls.map((c) => c.canvas)).toEqual([canvas]);
    expect(c2d.frames[0] === undefined ? [] : methods(c2d.frames[0])).toContain('setSpec');
    expect(transfers).toBe(0);
    expect(canvas.dataset['engine']).toBe('canvas2d');
  });

  it('a failed load sends this and later frames to Canvas 2D without loading again', async () => {
    const load = vi.fn(() => Promise.reject(new Error('no engine')));
    const c2d = fakeEngine();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const e = new RoutingEngine(load, c2d);
    const f1 = e.createFrame(document.createElement('canvas'), INIT);
    f1.setSpec(LINE_A);
    f1.setData(D);
    await flush();
    expect(c2d.frames).toHaveLength(1);
    expect(c2d.frames[0]?.last('setData')).toEqual([D]);
    const f2 = e.createFrame(document.createElement('canvas'), INIT);
    f2.setSpec(LINE_B);
    await flush();
    expect(c2d.frames).toHaveLength(2);
    expect(load).toHaveBeenCalledTimes(1);
    expect(transfers).toBe(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a frame that leaves line while the engine boots binds Canvas 2D (review r1 #1)', async () => {
    const b = backend();
    const c2d = fakeEngine();
    let resolve: (x: WasmBackend) => void = () => undefined;
    const e = new RoutingEngine(
      () =>
        new Promise<WasmBackend>((r) => {
          resolve = r;
        }),
      c2d,
    );
    const canvas = document.createElement('canvas');
    const f = e.createFrame(canvas, INIT);
    f.setSpec(LINE_A);
    f.setData(D);
    f.setSpec(BARS);
    resolve(b);
    await flush();
    expect(b.inner.createCalls).toHaveLength(0);
    expect(transfers).toBe(0);
    expect(c2d.createCalls.map((c) => c.canvas)).toEqual([canvas]);
    expect(c2d.frames[0]?.last('setSpec')).toEqual([BARS]);
    expect(c2d.frames[0]?.last('setData')).toEqual([D]);
    expect(canvas.dataset['engine']).toBe('canvas2d');
  });

  it('a frame disposed before the bind calls nothing', async () => {
    const b = backend();
    const c2d = fakeEngine();
    const e = new RoutingEngine(() => Promise.resolve(b), c2d);
    const f = e.createFrame(document.createElement('canvas'), INIT);
    f.setSpec(LINE_A);
    f.dispose();
    await flush();
    expect(b.inner.createCalls).toHaveLength(0);
    expect(c2d.createCalls).toHaveLength(0);
    expect(transfers).toBe(0);
  });

  it('mark and pick of a Canvas 2D bar chart reach the listeners (plan #68 C2a1 §2)', () => {
    const c2d = fakeEngine();
    const e = new RoutingEngine(() => Promise.resolve(backend()), c2d);
    const f = e.createFrame(document.createElement('canvas'), INIT);
    const marks: unknown[] = [];
    const picks: unknown[] = [];
    f.on('mark', (m) => marks.push(m));
    f.on('pick', (p) => picks.push(p));
    f.setSpec(BARS);
    const inner = c2d.frames[0];
    if (inner === undefined) throw new Error('not bound');
    const mark = {
      source: 'pointer',
      key: 'k1',
      index: 0,
      xCss: 10,
      yCss: 20,
      rows: [],
    } as FrameEvents['mark'];
    const pick = { keys: ['k1'], gesture: 'click' } as unknown as FrameEvents['pick'];
    inner.emit('mark', mark);
    inner.emit('mark', null);
    inner.emit('pick', pick);
    expect(marks).toEqual([mark, null]);
    expect(picks).toEqual([pick]);
  });

  it('routing: unbinding a frame with a shown hover clears it once (plan #68 C2b §4.4)', async () => {
    const b = backend();
    const c2d = fakeEngine();
    const e = new RoutingEngine(() => Promise.resolve(b), c2d);
    const host = document.createElement('div');
    const canvas = document.createElement('canvas');
    host.append(canvas);
    const f = e.createFrame(canvas, INIT);
    const hovers: FrameEvents['hover'][] = [];
    f.on('hover', (h) => hovers.push(h));
    f.setSpec(LINE_A);
    f.setData(D);
    f.resize(300, 150, 1);
    await flush();
    const inner = b.inner.frames[0];
    if (inner === undefined) throw new Error('not bound');
    const h: FrameEvents['hover'] = {
      source: 'pointer',
      tMs: 1,
      xCss: 10,
      yCss: 20,
      rows: [{ key: '00000000000000a1', name: '{}', colourIndex: 1, value: 3 }],
    };
    inner.emit('hover', h);
    expect(hovers).toEqual([h]);
    // The kind swap: the engine frame goes, its hover with it.
    f.setSpec(BARS);
    expect(hovers).toEqual([h, null]);
    f.setSpec(LINE_B);
    await flush();
    expect(hovers).toEqual([h, null]);
    // No hover shown: nothing on unbind.
    f.dispose();
    expect(hovers).toEqual([h, null]);
  });

  it('geomap: setFocusMark and cameraKey forwarded, the focus mark replayed on a rebind, the geo events forwarded (ADR-0027 §7)', async () => {
    const b = backend();
    const c2d = fakeEngine();
    const e = new RoutingEngine(() => Promise.resolve(b), c2d);
    const host = document.createElement('div');
    const canvas = document.createElement('canvas');
    host.append(canvas);
    const f = e.createFrame(canvas, INIT);
    f.setSpec(LINE_A);
    f.setData(D);
    await flush();
    expect(b.inner.frames).toHaveLength(1);
    // A line frame: both are no-ops there, and the focus mark is kept for a rebind.
    f.setFocusMark('a');
    // The kind swap: the geomap goes to Canvas 2D, which gets the focus mark.
    f.setSpec(GEO);
    const inner = c2d.frames[0];
    if (inner === undefined) throw new Error('not bound');
    expect(inner.last('setFocusMark')).toEqual(['a']);
    f.cameraKey('in');
    f.setFocusMark(null);
    expect(inner.calls.filter((c) => c.method === 'cameraKey' || c.method === 'setFocusMark')).toEqual([
      { method: 'setFocusMark', args: ['a'] },
      { method: 'cameraKey', args: ['in'] },
      { method: 'setFocusMark', args: [null] },
    ]);
    const seen: unknown[] = [];
    f.on('geoCommit', (x) => seen.push(['commit', x]));
    f.on('geoBrush', (x) => seen.push(['brush', x]));
    f.on('geoMarks', (x) => seen.push(['marks', x]));
    const commit: FrameEvents['geoCommit'] = {
      view: { lat: 1, lon: 2, zoom: 3 },
      bounds: { west: -10, south: -5, east: 10, north: 5 },
      gesture: 'keys',
    };
    const brush: FrameEvents['geoBrush'] = { keys: ['k01'] };
    const marks: FrameEvents['geoMarks'] = {
      level: 2,
      marks: [{ id: 'k01', kind: 'marker', keys: ['k01'], inView: true }],
    };
    inner.emit('geoCommit', commit);
    inner.emit('geoBrush', brush);
    inner.emit('geoMarks', marks);
    expect(seen).toEqual([
      ['commit', commit],
      ['brush', brush],
      ['marks', marks],
    ]);
  });

  it('geomap: a frame with no focus mark replays none', () => {
    const c2d = fakeEngine();
    const e = new RoutingEngine(() => Promise.resolve(backend()), c2d);
    const f = e.createFrame(document.createElement('canvas'), INIT);
    f.setSpec(GEO);
    expect(c2d.frames[0] === undefined ? [] : methods(c2d.frames[0])).toEqual([
      'setSpec',
      'setEvents',
      'setSelection',
    ]);
  });
});
