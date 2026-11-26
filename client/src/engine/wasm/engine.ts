/**
 * The WASM engine backend (plan #68 C1 §4.1–§4.3): compiles the engine (integrity-checked), boots
 * the render worker, routes its events to the frames and owns the restart policy. Loaded on the
 * first chart frame (`engine/index.ts`); `engine/route.ts` binds frames to it.
 *
 * | Condition | Behaviour |
 * |---|---|
 * | Status 4, a compile or integrity failure, or no status in 10 s | `loadBackend` rejects |
 * | A trap after at least one `drawn`, the first on the page | one restart: new workers from the same `Module`; every frame `onFail('restart')` |
 * | A trap before any `drawn`, a second trap, a restart that does not reach status 1 or 2 in 10 s, or `fatal` | `markFailed()`; every frame `onFail('trap')` |
 *
 * The session flag is injected (`markFailed`): this directory imports only `../api` (T03-001).
 */
import type { ChartFrame, FrameInit } from '../api';
import {
  BOOT_TIMEOUT_MS,
  bootFaults,
  startRender,
  type RenderHandle,
  type Status,
  type WorkerLike,
} from './boot';
import { WasmFrame, type Port } from './frame';
import { fetchEngineWasm } from './integrity';
import type { MainToRender, RenderEvent } from './protocol';
import { spawnPool, spawnRender } from './workers';

export type { WorkerLike } from './boot';

export interface EngineOptions {
  readonly forceT2: boolean;
  /** `markSessionFailed` (failFlag.ts). */
  readonly markFailed: () => void;
  /** Tests: the module, worker factories and the boot timeout. */
  readonly compile?: () => Promise<WebAssembly.Module>;
  readonly spawnRender?: () => WorkerLike;
  readonly spawnPool?: () => WorkerLike;
  readonly timeoutMs?: number;
}

export interface Backend {
  readonly tier: 't1' | 't2';
  createFrame(
    canvas: OffscreenCanvas,
    init: FrameInit,
    onFail: (reason: string) => void,
  ): ChartFrame;
}

/** Fetches (with integrity) and compiles the engine; never instantiates it here. */
async function compileEngine(): Promise<WebAssembly.Module> {
  const { wasmUrl } = await import('virtual:dash-engine');
  if (wasmUrl === null) throw new Error('the engine is not in this build');
  const r = await fetchEngineWasm(wasmUrl, {
    fetch: globalThis.fetch.bind(globalThis),
    dev: import.meta.env.DEV,
  });
  if (!r.ok) throw new Error(r.reason);
  return WebAssembly.compileStreaming(r.response);
}

function showStatus(s: number, adapter?: string): void {
  if (typeof document === 'undefined') return;
  const d = document.documentElement.dataset;
  d['dashStatus'] = String(s);
  d['dashMode'] = 'mt';
  if (adapter !== undefined) d['dashAdapter'] = adapter;
}

const ready = (s: Status | null): boolean => s !== null && (s.status === 1 || s.status === 2);

interface Entry {
  readonly frame: WasmFrame;
  readonly onFail: (reason: string) => void;
}

class EngineHost implements Backend {
  tier: 't1' | 't2' = 't1';
  private render: RenderHandle | null = null;
  private readonly frames = new Map<number, Entry>();
  private nextId = 1;
  private drawn = false;
  private restarted = false;
  private state: 'booting' | 'ready' | 'restarting' | 'dead' = 'booting';
  private readonly queue: [MainToRender, Transferable[]][] = [];
  private faultOf: (restart: boolean) => string | undefined = () => undefined;
  private readonly port: Port = {
    postMessage: (msg, transfer = []) => {
      if (this.state === 'ready' && this.render !== null)
        this.render.worker.postMessage(msg, transfer);
      else if (this.state !== 'dead') this.queue.push([msg, transfer]);
    },
  };

  constructor(
    private readonly o: EngineOptions,
    private readonly module: WebAssembly.Module,
  ) {}

  private start(fault: string | undefined): RenderHandle {
    return startRender({
      module: this.module,
      forceT2: this.o.forceT2,
      fault,
      spawnRender: this.o.spawnRender ?? spawnRender,
      spawnPool: this.o.spawnPool ?? spawnPool,
      timeoutMs: this.o.timeoutMs ?? BOOT_TIMEOUT_MS,
      onEvents: (json) => {
        this.events(json);
      },
      onError: () => {
        this.trap();
      },
    });
  }

  async boot(): Promise<void> {
    showStatus(0);
    this.faultOf = await bootFaults();
    this.render = this.start(this.faultOf(false));
    const s = await this.render.status;
    if (s === null || !ready(s)) {
      this.render.terminate();
      this.state = 'dead';
      showStatus(4);
      throw new Error(`engine status ${s === null ? 'timeout' : String(s.status)}`);
    }
    this.up(s);
  }

  private up(s: Status): void {
    this.tier = s.status === 1 ? 't1' : 't2';
    showStatus(s.status, s.adapter);
    this.state = 'ready';
    for (const [msg, transfer] of this.queue.splice(0))
      this.render?.worker.postMessage(msg, transfer);
  }

  createFrame(
    canvas: OffscreenCanvas,
    init: FrameInit,
    onFail: (reason: string) => void,
  ): ChartFrame {
    const id = this.nextId++;
    const frame = new WasmFrame(this.port, id, canvas, init, onFail);
    this.frames.set(id, { frame, onFail });
    const dispose = frame.dispose.bind(frame);
    frame.dispose = () => {
      if (this.frames.get(id)?.frame === frame) this.frames.delete(id);
      dispose();
    };
    return frame;
  }

  private events(json: string): void {
    let list: RenderEvent[];
    try {
      list = JSON.parse(json) as RenderEvent[];
    } catch {
      return;
    }
    for (const ev of list) {
      if (ev.t === 'fatal') {
        this.fatal();
        return;
      }
      if (ev.t === 'tier') {
        // Later frames bind on the new tier; the old ones fall back (`failed{tier}`).
        this.tier = ev.tier;
        showStatus(ev.status, ev.adapter);
        continue;
      }
      if (ev.t === 'drawn') this.drawn = true;
      this.frames.get(ev.id)?.frame.handle(ev);
    }
  }

  /** An uncaught error in the render worker. */
  private trap(): void {
    if (this.state === 'dead') return;
    if (!this.drawn || this.restarted || this.state !== 'ready') {
      this.fatal();
      return;
    }
    void this.restart();
  }

  private async restart(): Promise<void> {
    this.restarted = true;
    this.state = 'restarting';
    this.render?.terminate();
    const old = [...this.frames.values()];
    this.frames.clear();
    for (const e of old) e.frame.detach();
    // A new worker: its frames are numbered afresh.
    this.nextId = 1;
    this.render = this.start(this.faultOf(true));
    for (const e of old) e.onFail('restart');
    const s = await this.render.status;
    if (this.isDead()) return;
    if (s === null || !ready(s)) {
      this.fatal();
      return;
    }
    this.up(s);
  }

  private isDead(): boolean {
    return this.state === 'dead';
  }

  private fatal(): void {
    if (this.state === 'dead') return;
    this.state = 'dead';
    this.queue.length = 0;
    this.render?.terminate();
    showStatus(4);
    this.o.markFailed();
    const all = [...this.frames.values()];
    this.frames.clear();
    for (const e of all) e.onFail('trap');
  }
}

export async function loadBackend(o: EngineOptions): Promise<Backend> {
  const module = await (o.compile ?? compileEngine)();
  const host = new EngineHost(o, module);
  await host.boot();
  return host;
}
