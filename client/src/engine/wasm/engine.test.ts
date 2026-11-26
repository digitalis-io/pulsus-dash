/**
 * The restart policy (plan #68 C1 §4.3, T03 §9.2): one restart per page after a draw; a trap
 * before any draw, a second trap or a failed restart sends every engine frame to Canvas 2D and
 * marks the session, so later frames start on Canvas 2D.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeEngine } from '../../test/fakeEngine';
import type { ChartEngine, FrameData, VisSpec } from '../api';
import { RoutingEngine } from '../route';
import { loadBackend, type WorkerLike } from './engine';

const S: VisSpec = { kind: 'line', title: 'T', unit: { kind: 'none' } };
const D: FrameData = {
  kind: 'series',
  series: [
    {
      key: '00000000000000aa',
      labels: { job: 'api' },
      timestamps: new Float64Array([1, 2]),
      values: new Float64Array([3, 4]),
    },
  ],
};
const W = { fromMs: 0, toMs: 10 };
const KEY = 'pulsus-dash.engine-failed';
const MODULE = { tag: 'module' } as unknown as WebAssembly.Module;

interface Msg {
  readonly t: string;
  readonly [k: string]: unknown;
}

class FakeWorker implements WorkerLike {
  readonly sent: Msg[] = [];
  terminated = false;
  private readonly listeners = new Map<string, ((e: unknown) => void)[]>();
  postMessage(msg: unknown): void {
    this.sent.push(msg as Msg);
  }
  terminate(): void {
    this.terminated = true;
  }
  addEventListener(type: string, cb: (e: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
  }
  emit(type: string, e: unknown): void {
    for (const cb of this.listeners.get(type) ?? []) cb(e);
  }
  message(data: unknown): void {
    this.emit('message', { data });
  }
  status(status = 1): void {
    this.message({ t: 'status', status, adapter: 'swiftshader', cb: 64, memory: {} });
    this.message({ t: 'spawn-pool', ptr: 8 });
  }
  drawn(id: number): void {
    const ev = { cssWidth: 300, cssHeight: 150, dpr: 1 };
    this.message({
      t: 'events',
      json: JSON.stringify([{ t: 'drawn', id, ev, startMs: 1, endMs: 2, series: 1 }]),
    });
  }
  trap(): void {
    this.emit('error', { message: 'unreachable' });
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

interface Page {
  readonly render: FakeWorker[];
  readonly pools: FakeWorker[];
  readonly c2d: ReturnType<typeof fakeEngine>;
  readonly host: HTMLElement;
  readonly engine: ChartEngine;
}

async function page(markFailed: () => void): Promise<Page> {
  const render: FakeWorker[] = [];
  const pools: FakeWorker[] = [];
  const c2d = fakeEngine();
  const engine = new RoutingEngine(
    () =>
      loadBackend({
        forceT2: false,
        markFailed,
        compile: () => Promise.resolve(MODULE),
        spawnRender: () => {
          const w = new FakeWorker();
          render.push(w);
          return w;
        },
        spawnPool: () => {
          const w = new FakeWorker();
          pools.push(w);
          return w;
        },
        timeoutMs: 10_000,
      }),
    c2d,
  );
  const host = document.createElement('div');
  const canvas = document.createElement('canvas');
  host.append(canvas);
  document.body.append(host);
  const f = engine.createFrame(canvas, { timeZone: 'UTC', keyTarget: null, id: 'f1' });
  f.setSpec(S);
  f.setData(D);
  f.setTimeWindow(W);
  f.setTheme('dark');
  f.resize(300, 150, 1);
  await flush();
  render[0]?.status();
  await flush();
  return { render, pools, c2d, host, engine };
}

const canvases = (h: HTMLElement): HTMLCanvasElement[] => [...h.querySelectorAll('canvas')];
const notices = (h: HTMLElement): number => h.querySelectorAll('[data-engine-notice]').length;

let transferred: unknown[] = [];
beforeEach(() => {
  sessionStorage.clear();
  transferred = [];
  Object.defineProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen', {
    configurable: true,
    value(this: HTMLCanvasElement) {
      const off = { from: this } as unknown as OffscreenCanvas;
      transferred.push(off);
      return off;
    },
  });
});
afterEach(() => {
  Reflect.deleteProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen');
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

/** (a) up to the restart: #2 booted with the frame replayed. */
async function restarted(p: Page): Promise<FakeWorker> {
  const [w1] = p.render;
  if (w1 === undefined) throw new Error('no render worker');
  w1.drawn(1);
  w1.trap();
  await flush();
  expect(w1.terminated).toBe(true);
  expect(p.pools.map((w) => w.terminated)).toEqual([true]);
  expect(p.render).toHaveLength(2);
  const w2 = p.render[1];
  if (w2 === undefined) throw new Error('no restart');
  expect(w2.sent[0]).toMatchObject({ t: 'boot', module: MODULE });
  w2.status();
  await flush();
  const after = w2.sent.slice(1);
  expect(after.map((m) => m.t)).toEqual(['create', 'spec', 'data', 'window', 'theme', 'resize']);
  expect(after[0]).toMatchObject({ t: 'create', id: 1, frameId: 'f1' });
  expect(after[0]?.['canvas']).toBe(transferred[1]);
  expect(transferred[1]).not.toBe(transferred[0]);
  expect(after[4]).toEqual({ t: 'theme', id: 1, theme: 0 });
  expect(after[5]).toEqual({ t: 'resize', id: 1, w: 300, h: 150, dpr: 1 });
  const [c1, c2] = canvases(p.host);
  expect(c1?.hasAttribute('data-retired')).toBe(true);
  expect(c2?.dataset['engine']).toBe('wasm-webgpu');
  expect(notices(p.host)).toBe(1);
  return w2;
}

describe('engine restart policy (T03 §9.2)', () => {
  it('(a) a trap after a draw restarts once; a second trap falls back for good', async () => {
    const { markSessionFailed } = await import('../failFlag');
    const p = await page(markSessionFailed);
    const w2 = await restarted(p);
    w2.trap();
    await flush();
    expect(p.render).toHaveLength(2);
    const c3 = canvases(p.host)[2];
    expect(c3?.dataset['engine']).toBe('canvas2d');
    expect(p.c2d.createCalls.map((c) => c.canvas)).toEqual([c3]);
    const fr = p.c2d.frames[0];
    expect([fr?.last('setSpec'), fr?.last('setData'), fr?.last('setTimeWindow')]).toEqual([
      [S],
      [D],
      [W],
    ]);
    expect(sessionStorage.getItem(KEY)).toBe('1');
  });

  it('(b) a trap before any draw falls back without a restart', async () => {
    const { markSessionFailed } = await import('../failFlag');
    const p = await page(markSessionFailed);
    p.render[0]?.trap();
    await flush();
    expect(p.render).toHaveLength(1);
    expect(canvases(p.host)[1]?.dataset['engine']).toBe('canvas2d');
    expect(notices(p.host)).toBe(1);
    expect(sessionStorage.getItem(KEY)).toBe('1');
  });

  it('a restart that does not reach status 1 or 2 falls back', async () => {
    const { markSessionFailed } = await import('../failFlag');
    const p = await page(markSessionFailed);
    p.render[0]?.drawn(1);
    p.render[0]?.trap();
    await flush();
    p.render[1]?.status(4);
    await flush();
    expect(p.c2d.frames).toHaveLength(1);
    expect(sessionStorage.getItem(KEY)).toBe('1');
  });

  it('(c) with a throwing sessionStorage the page still ends the engine', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const { markSessionFailed } = await import('../failFlag');
    const p = await page(markSessionFailed);
    const w2 = await restarted(p);
    w2.trap();
    await flush();
    expect(sessionStorage.getItem(KEY)).toBe(null);
    expect(p.c2d.frames).toHaveLength(1);
    const later = document.createElement('canvas');
    p.host.append(later);
    const f = p.engine.createFrame(later, { timeZone: 'UTC', keyTarget: null });
    f.setSpec(S);
    await flush();
    expect(p.c2d.createCalls.at(-1)?.canvas).toBe(later);
    expect(p.render).toHaveLength(2);
  });

  it('device loss: a restore on another tier moves the frames to Canvas 2D; later frames use it (review r1 #3)', async () => {
    const { markSessionFailed } = await import('../failFlag');
    const p = await page(markSessionFailed);
    const [w1] = p.render;
    const before = document.documentElement.dataset;
    expect([before['dashStatus'], before['dashAdapter']]).toEqual(['1', 'swiftshader']);
    // T1 lost, only WebGL2 left: the worker reports the new tier and fails the old frames.
    w1?.message({
      t: 'events',
      json: JSON.stringify([
        { t: 'tier', tier: 't2', status: 2, adapter: 'llvmpipe (LLVM 20)' },
        { t: 'failed', id: 1, reason: 'tier' },
      ]),
    });
    await flush();
    // The page's status follows the tier change (review r2 #1).
    const html = document.documentElement.dataset;
    expect([html['dashStatus'], html['dashAdapter']]).toEqual(['2', 'llvmpipe (LLVM 20)']);
    const c2 = canvases(p.host)[1];
    expect(c2?.dataset['engine']).toBe('canvas2d');
    expect(notices(p.host)).toBe(1);
    const fr = p.c2d.frames[0];
    expect([fr?.last('setSpec'), fr?.last('setData'), fr?.last('setTimeWindow')]).toEqual([
      [S],
      [D],
      [W],
    ]);
    expect(p.render).toHaveLength(1);
    expect(sessionStorage.getItem(KEY)).toBe(null);
    // A later line frame binds on the new tier.
    const later = document.createElement('canvas');
    p.host.append(later);
    p.engine.createFrame(later, { timeZone: 'UTC', keyTarget: null }).setSpec(S);
    await flush();
    expect(later.dataset['engine']).toBe('wasm-webgl2');
  });

  it('device loss: a fatal report (repeated loss, failed restore) ends the engine (review r1 #2)', async () => {
    const { markSessionFailed } = await import('../failFlag');
    const p = await page(markSessionFailed);
    p.render[0]?.drawn(1);
    p.render[0]?.message({
      t: 'events',
      json: JSON.stringify([{ t: 'fatal', reason: 'device-lost' }]),
    });
    await flush();
    expect(canvases(p.host)[1]?.dataset['engine']).toBe('canvas2d');
    expect(p.render).toHaveLength(1);
    expect(p.render[0]?.terminated).toBe(true);
    expect(sessionStorage.getItem(KEY)).toBe('1');
  });
});
