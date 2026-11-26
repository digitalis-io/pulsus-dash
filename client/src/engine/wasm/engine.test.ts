/**
 * The restart policy (plan #68 C1 §4.3, T03 §9.2): one restart per page after a draw; a trap
 * before any draw, a second trap or a failed restart sends every engine frame to Canvas 2D and
 * marks the session, so later frames start on Canvas 2D. Part C2a1 (§3.1, §4.1, §4.4, §5 `created
 * gate`, `dispose`, `restart`): every status gets a new input ring on its memory; a frame's
 * records wait for its `created` and are dropped by its dispose.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeEngine } from '../../test/fakeEngine';
import { CB, KIND_CAMERA, KIND_OVERLAY, KIND_RESIZE, memory, RingView } from '../../test/ringView';
import type { ChartEngine, FrameData, VisSpec } from '../api';
import { RoutingEngine } from '../route';
import { loadBackend, type Backend, type WorkerLike } from './engine';

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
  /** The worker's engine memory: the control block at `CB`, idle at boot (T03 §4.3). */
  readonly memory = memory();
  readonly ring = new RingView(this.memory);
  constructor() {
    this.ring.setIdle(1);
  }
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
    this.message({ t: 'status', status, adapter: 'swiftshader', cb: CB, memory: this.memory });
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
  created(...ids: number[]): void {
    this.message({ t: 'events', json: JSON.stringify(ids.map((id) => ({ t: 'created', id }))) });
  }
  inputs(): number {
    return this.sent.filter((m) => m.t === 'input').length;
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
  // Plan #68 C2c1: the replayed events (none) go too; C2c2: and the replayed selection (none).
  expect(after.map((m) => m.t)).toEqual(['create', 'spec', 'data', 'theme', 'events', 'selection']);
  expect(after[0]).toMatchObject({ t: 'create', id: 1, frameId: 'f1' });
  expect(after[0]?.['canvas']).toBe(transferred[1]);
  expect(transferred[1]).not.toBe(transferred[0]);
  expect(after[3]).toEqual({ t: 'theme', id: 1, theme: 0 });
  expect(after[4]).toEqual({ t: 'events', id: 1, atMs: new Float64Array([]) });
  // A new ring on the new worker's memory: the frame's camera, overlay (plan #68 C2b) and size
  // wait for its `created`.
  expect(w2.ring.head()).toBe(0);
  w2.created(1);
  expect(w2.ring.decode().map((r) => [r.kind, r.frame, r.seq])).toEqual([
    [KIND_CAMERA, 1, 1],
    [KIND_OVERLAY, 1, 2],
    [KIND_RESIZE, 1, 3],
  ]);
  expect(w2.inputs()).toBe(1);
  expect(w1.ring.decode()).toEqual([]);
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

const INIT = { timeZone: 'UTC', keyTarget: null } as const;

async function backend(o: { start?: number } = {}): Promise<{ b: Backend; w: FakeWorker }> {
  const render: FakeWorker[] = [];
  const p = loadBackend({
    forceT2: false,
    markFailed: () => undefined,
    compile: () => Promise.resolve(MODULE),
    spawnRender: () => {
      const w = new FakeWorker();
      render.push(w);
      return w;
    },
    spawnPool: () => new FakeWorker(),
    timeoutMs: 10_000,
  });
  await flush();
  const w = render[0];
  if (w === undefined) throw new Error('no render worker');
  if (o.start !== undefined) w.ring.setCounters(o.start);
  w.status();
  return { b: await p, w };
}

const canvas = (): OffscreenCanvas => ({}) as OffscreenCanvas;
const sleep = (ms: number): Promise<void> =>
  new Promise((r) => {
    setTimeout(r, ms);
  });

describe('the input ring and the created gate (plan #68 C2a1)', () => {
  it('a frame’s records wait for its created, then go in call order', async () => {
    for (const start of [0, 0xffff_ff00]) {
      const { b, w } = await backend({ start });
      const frames = Array.from({ length: 300 }, () => b.createFrame(canvas(), INIT, () => {}));
      for (const f of frames) {
        f.setSpec(S);
        f.resize(300, 150, 1);
        f.setCamera({ view: { lo: W.fromMs, hi: W.toMs }, value: null, band: null });
      }
      expect(w.ring.head()).toBe(start);
      expect(w.inputs()).toBe(0);
      w.created(...frames.map((_, i) => i + 1));
      const recs = w.ring.decode();
      expect(recs).toHaveLength(600);
      expect(recs.map((r) => [r.kind, r.frame, r.seq])).toEqual(
        frames.flatMap((_, i) => [
          [KIND_RESIZE, i + 1, 1],
          [KIND_CAMERA, i + 1, 2],
        ]),
      );
      expect(w.inputs()).toBe(1);
      if (start !== 0) expect(w.ring.head()).toBeLessThan(start);
      // (b) After created: at once.
      frames[0]?.setCamera({ view: { lo: 5, hi: 6 }, value: null, band: null });
      expect(w.ring.decode().map((r) => [r.kind, r.frame, r.seq, r.f[0]])).toEqual([
        [KIND_CAMERA, 1, 3, 5],
      ]);
    }
  });

  it('dispose drops held and pending records; a late created or drawn is ignored', async () => {
    const { b, w } = await backend();
    const a = b.createFrame(canvas(), INIT, () => {});
    const z = b.createFrame(canvas(), INIT, () => {});
    const early = b.createFrame(canvas(), INIT, () => {});
    early.resize(300, 150, 1);
    // (a) Disposed before created, (b) its created arrives after.
    early.dispose();
    w.created(1, 2, 3);
    expect(w.ring.decode()).toEqual([]);
    expect(w.sent.filter((m) => m['id'] === 3).map((m) => m.t)).toEqual(['create', 'dispose']);
    // (c) A has a published and a pending record, then is disposed.
    a.resize(300, 150, 1);
    for (let i = 0; i < 1100; i++)
      z.setCamera({ view: { lo: i, hi: i + 1 }, value: null, band: null });
    a.setCamera({ view: { lo: 1, hi: 2 }, value: null, band: null });
    const got = vi.fn();
    a.on('drawn', got);
    a.dispose();
    const first = w.ring.decode();
    expect(first.filter((r) => r.frame === 1).map((r) => r.kind)).toEqual([KIND_RESIZE]);
    await sleep(60);
    expect(w.ring.decode().filter((r) => r.frame === 1)).toEqual([]);
    w.message({
      t: 'events',
      json: JSON.stringify([
        {
          t: 'drawn',
          id: 1,
          ev: { cssWidth: 300, cssHeight: 150, dpr: 1 },
          startMs: 1,
          endMs: 2,
          series: 1,
          seq: 1,
          rseq: 1,
        },
      ]),
    });
    expect(got).not.toHaveBeenCalled();
    expect(w.sent.filter((m) => m['id'] === 1).map((m) => m.t)).toEqual(['create', 'dispose']);
  });
});
