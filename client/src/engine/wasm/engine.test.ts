/**
 * The restart policy (plan #68 C1 §4.3, T03 §9.2): one restart per page after a draw; a trap
 * before any draw, a second trap or a failed restart sends every engine frame to Canvas 2D and
 * marks the session, so later frames start on Canvas 2D.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeEngine } from '../../test/fakeEngine';
import type { ChartEngine, ChartFrame, VisSpec } from '../api';
import { RoutingEngine } from '../route';
import { loadBackend, type WorkerLike } from './engine';

const LINE: VisSpec = { kind: 'line', title: 'T', unit: { kind: 'none' } };
const KEY = 'pulsus-dash.engine-failed';

class FakeWorker implements WorkerLike {
  readonly sent: { t: string; id?: number }[] = [];
  terminated = false;
  private readonly listeners = new Map<string, ((e: unknown) => void)[]>();
  postMessage(msg: unknown): void {
    this.sent.push(msg as { t: string });
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
    this.message({ t: 'status', status, adapter: 'llvmpipe (LLVM 20)', cb: 64, memory: {} });
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
  created(): number[] {
    return this.sent.filter((m) => m.t === 'create').map((m) => m.id ?? -1);
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

interface Page {
  engine: ChartEngine;
  render: FakeWorker[];
  c2d: ReturnType<typeof fakeEngine>;
  hosts: HTMLElement[];
  frames: ChartFrame[];
  frame(): ChartFrame;
}

async function page(markFailed: () => void): Promise<Page> {
  const render: FakeWorker[] = [];
  const c2d = fakeEngine();
  const hosts: HTMLElement[] = [];
  const frames: ChartFrame[] = [];
  const engine = new RoutingEngine(
    () =>
      loadBackend({
        forceT2: false,
        markFailed,
        compile: () => Promise.resolve({} as WebAssembly.Module),
        spawnRender: () => {
          const w = new FakeWorker();
          render.push(w);
          return w;
        },
        spawnPool: () => new FakeWorker(),
        timeoutMs: 10_000,
      }),
    c2d,
  );
  const frame = (): ChartFrame => {
    const host = document.createElement('div');
    const canvas = document.createElement('canvas');
    host.append(canvas);
    document.body.append(host);
    hosts.push(host);
    const f = engine.createFrame(canvas, { timeZone: 'UTC', keyTarget: null });
    f.setSpec(LINE);
    f.resize(300, 150, 1);
    frames.push(f);
    return f;
  };
  frame();
  frame();
  await flush();
  render[0]?.status();
  await flush();
  return { engine, render, c2d, hosts, frames, frame };
}

const live = (h: HTMLElement): HTMLCanvasElement[] => [
  ...h.querySelectorAll<HTMLCanvasElement>('canvas:not([data-retired])'),
];
const notices = (h: HTMLElement): number => h.querySelectorAll('[data-engine-notice]').length;

beforeEach(() => {
  sessionStorage.clear();
  vi.resetModules();
  Object.defineProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen', {
    configurable: true,
    value: () => ({ width: 0, height: 0 }) as unknown as OffscreenCanvas,
  });
});
afterEach(() => {
  Reflect.deleteProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen');
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('engine restart policy (T03 §9.2)', () => {
  it('a trap after a draw restarts once; a second trap falls back for good', async () => {
    const { markSessionFailed, sessionFailed } = await import('../failFlag');
    const p = await page(markSessionFailed);
    const [w0] = p.render;
    if (w0 === undefined) throw new Error('no render worker');
    expect(w0.created()).toHaveLength(2);
    w0.drawn(w0.created()[0] ?? -1);
    w0.trap();
    await flush();
    expect(w0.terminated).toBe(true);
    expect(p.render).toHaveLength(2);
    const w1 = p.render[1];
    if (w1 === undefined) throw new Error('no restart');
    w1.status();
    await flush();
    expect(w1.created()).toHaveLength(2);
    for (const h of p.hosts) {
      expect(h.querySelectorAll('canvas')).toHaveLength(2);
      expect(live(h).map((c) => c.dataset['engine'])).toEqual(['wasm-webgpu']);
      expect(notices(h)).toBe(1);
    }
    // The state is replayed into the new worker.
    expect(w1.sent.filter((m) => m.t === 'spec')).toHaveLength(2);
    expect(w1.sent.filter((m) => m.t === 'resize')).toHaveLength(2);
    expect(sessionFailed()).toBe(false);

    w1.trap();
    await flush();
    expect(p.render).toHaveLength(2);
    expect(p.c2d.frames).toHaveLength(2);
    for (const h of p.hosts) expect(live(h).map((c) => c.dataset['engine'])).toEqual(['canvas2d']);
    expect(sessionStorage.getItem(KEY)).toBe('1');
    // A later frame starts on Canvas 2D.
    p.frame();
    await flush();
    expect(p.c2d.frames).toHaveLength(3);
  });

  it('a trap before any draw falls back without a restart', async () => {
    const { markSessionFailed } = await import('../failFlag');
    const p = await page(markSessionFailed);
    p.render[0]?.trap();
    await flush();
    expect(p.render).toHaveLength(1);
    expect(p.c2d.frames).toHaveLength(2);
    for (const h of p.hosts) expect(notices(h)).toBe(1);
    expect(sessionStorage.getItem(KEY)).toBe('1');
  });

  it('a restart that does not reach status 1 or 2 falls back', async () => {
    vi.useFakeTimers();
    try {
      const { markSessionFailed } = await import('../failFlag');
      const p = await page(markSessionFailed);
      const w0 = p.render[0];
      w0?.drawn(w0.created()[0] ?? -1);
      w0?.trap();
      await flush();
      expect(p.render).toHaveLength(2);
      p.render[1]?.status(4);
      await flush();
      expect(p.c2d.frames).toHaveLength(2);
      expect(sessionStorage.getItem(KEY)).toBe('1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('with a throwing sessionStorage the page still falls back and later frames use Canvas 2D', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const { markSessionFailed, sessionFailed } = await import('../failFlag');
    const p = await page(markSessionFailed);
    p.render[0]?.trap();
    await flush();
    expect(p.c2d.frames).toHaveLength(2);
    expect(sessionFailed()).toBe(true);
    p.frame();
    await flush();
    expect(p.c2d.frames).toHaveLength(3);
    expect(p.render).toHaveLength(1);
  });
});
