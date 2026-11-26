import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeEngine, type FakeEngine, type FakeFrame } from '../test/fakeEngine';
import type { ChartFrame, FrameData, FrameInit, VisSpec } from './api';
import { RoutingEngine, type WasmBackend } from './route';

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
    createFrame(canvas: OffscreenCanvas, init: FrameInit, onFail): ChartFrame {
      fails.push(onFail);
      return inner.createFrame(canvas as unknown as HTMLCanvasElement, init);
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
  it('a line frame binds to the engine after boot and replays the latest state once, in order', async () => {
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
    expect(inner.calls).toEqual([
      { method: 'setSpec', args: [LINE_B] },
      { method: 'setData', args: [D] },
      { method: 'setTimeWindow', args: [W] },
      { method: 'setTheme', args: ['light'] },
      { method: 'setEvents', args: [[]] },
      { method: 'setSelection', args: [null] },
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
});
