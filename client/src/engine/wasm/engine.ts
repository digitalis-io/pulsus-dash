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
 * Part C2a1 (§3.1, §4.1): each status (boot, restart) gets a new input ring on the worker's memory
 * before any queued `create` is posted; a frame's camera and size reach the ring only after the
 * worker reports it `created`. Frame ids count up from 1 per worker and are never reused.
 *
 * The session flag is injected (`markFailed`): this directory imports only `../api` (T03-001).
 */
import type { FrameInit } from '../api';
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
import {
  CB_BYTES,
  OFF_INPUT_BAD,
  OFF_INPUT_HEAD,
  OFF_INPUT_IDLE,
  OFF_INPUT_OVERFLOW,
  OFF_INPUT_TAIL,
} from './layout.gen';
import type { MainToRender, RenderEvent } from './protocol';
import { InputRing, type InputRec } from './ring';
import { spawnPool, spawnRender } from './workers';

export type { WorkerLike } from './boot';

export interface EngineOptions {
  readonly forceT2: boolean;
  /** `markSessionFailed` (failFlag.ts). */
  readonly markFailed: () => void;
  /** Plan #68 C2d2 (stub): the engine mode. */
  readonly mode?: 'mt' | 'st';
  /** Tests: the module, worker factories and the boot timeout. */
  readonly compile?: (mode: 'mt' | 'st') => Promise<WebAssembly.Module>;
  readonly spawnRender?: () => WorkerLike;
  readonly spawnPool?: () => WorkerLike;
  readonly timeoutMs?: number;
  /** Fault builds with `?probe=1` only (`dev/engineProbe.ts`). */
  readonly probe?: EngineProbe;
}

/** The probe's hooks into the engine (plan #68 C2a1 §3.4, §3.5). */
export interface EngineProbe {
  /** The input ring's counters start here (the probe build's `engine_probe_ring_start`). */
  readonly ringStart?: number;
  /** Each status: the running engine's ring and counters. */
  onHost(h: ProbeHost): void;
}

/** What `__dashProbe` reads of the running engine (fault builds only; plan #68 C2a1 §3.4). */
export interface ProbeHost {
  readonly ring: InputRing;
  counters(): { head: number; tail: number };
  overflow(): number;
  idle(): boolean;
  inputLog(): Promise<InputRec[]>;
  /** `INPUT_BAD`: records the worker rejected. */
  bad(): number;
  /** The probe build (plan #68 C2b §3.4): the worker holds frame `id` after seq `seq`, or not. */
  freeze(id: number, seq: number): void;
  unfreeze(id: number): void;
  /** The probe build (plan #68 C2c2 S11): every renderer made again. */
  renew(): void;
  /**
   * The probe build (plan #68 C2d1 §3.2): F1c of `series` × `points` as frame `id`'s data; resolves
   * on the worker's acknowledgement, or `ok: false` when the engine restarts or fails first.
   */
  synth(id: number, series: number, points: number): Promise<SynthAck>;
  /** The probe build: frame `id`'s current chunk, or null. */
  chunk(id: number): Promise<ChunkInfo | null>;
  /** The probe build (plan #68 C2d1): the render worker traps. */
  trap(): void;
}

/**
 * `synth`'s outcome: `bytes` of values held. Not `ok`: `alloc` (the worker's allocation failed;
 * the frame is unchanged), `restart` or `fatal` (the engine went first), `timeout` (no answer).
 */
export interface SynthAck {
  readonly ok: boolean;
  readonly bytes: number;
  readonly reason?: 'alloc' | 'restart' | 'fatal' | 'timeout';
}

/** A frame's chunk as the probe build describes it: series, samples of series 0, value bytes. */
export interface ChunkInfo {
  readonly series: number;
  readonly points: number;
  readonly bytes: number;
}

export interface Backend {
  readonly tier: 't1' | 't2';
  createFrame(
    canvas: OffscreenCanvas,
    init: FrameInit,
    onFail: (reason: string) => void,
  ): WasmFrame;
}

/** Fetches (with integrity) and compiles the engine; never instantiates it here. */
async function compileEngine(_mode: 'mt' | 'st'): Promise<WebAssembly.Module> {
  const { wasmUrl } = await import('virtual:dash-engine');
  if (wasmUrl === null) {
    // Not a boot failure: `markOnFailure` leaves the session unmarked (plan #256 §3.2).
    throw Object.assign(new Error('the engine is not in this build'), { name: 'EngineAbsent' });
  }
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
  /** The input ring of the current worker's memory (from its status on). */
  private ring: InputRing | null = null;
  /** The probe build: `inputLog()` calls waiting for the worker's reply. */
  private readonly probeWaits: ((json: string) => void)[] = [];
  /** The probe build: `synth()` calls waiting for their acknowledgement, in order. */
  private readonly synthWaits: { id: number; resolve: (a: SynthAck) => void }[] = [];
  /** The probe build: `chunk()` calls waiting for their answer, in order. */
  private readonly chunkWaits: { id: number; resolve: (c: ChunkInfo | null) => void }[] = [];
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
      ...(this.o.probe?.ringStart === undefined ? {} : { ringStart: this.o.probe.ringStart }),
      onProbeInput: (json) => {
        this.probeWaits.shift()?.(json);
      },
      onProbeSynth: (m) => {
        const i = this.synthWaits.findIndex((w) => w.id === m.id);
        if (i < 0) return;
        const [w] = this.synthWaits.splice(i, 1);
        w?.resolve(m.ok ? { ok: true, bytes: m.bytes } : { ok: false, bytes: 0, reason: 'alloc' });
      },
      onProbeChunk: (m) => {
        const i = this.chunkWaits.findIndex((w) => w.id === m.id);
        if (i < 0) return;
        const [w] = this.chunkWaits.splice(i, 1);
        w?.resolve(JSON.parse(m.json) as ChunkInfo | null);
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
    // A new ring on this worker's memory before any `create` is posted.
    this.ring?.close();
    const worker = this.render?.worker;
    const probe = import.meta.env.VITE_ENGINE_FAULTS === '1' ? this.o.probe : undefined;
    const ring = new InputRing(
      s.memory,
      s.cb,
      () => {
        worker?.postMessage({ t: 'input' } satisfies MainToRender);
      },
      probe === undefined ? {} : { log: true },
    );
    this.ring = ring;
    if (probe !== undefined && worker !== undefined) probe.onHost(this.probeHost(ring, worker, s));
    for (const [msg, transfer] of this.queue.splice(0))
      this.render?.worker.postMessage(msg, transfer);
  }

  /** What the probe reads of this engine (fault builds only). */
  private probeHost(ring: InputRing, worker: WorkerLike, s: Status): ProbeHost {
    const i32 = new Int32Array(s.memory.buffer, s.cb, CB_BYTES / 4);
    const word = (off: number): number => Atomics.load(i32, off / 4) >>> 0;
    return {
      ring,
      counters: () => ({ head: word(OFF_INPUT_HEAD), tail: word(OFF_INPUT_TAIL) }),
      overflow: () => word(OFF_INPUT_OVERFLOW),
      idle: () => word(OFF_INPUT_IDLE) === 1,
      bad: () => word(OFF_INPUT_BAD),
      freeze: (id, seq) => {
        worker.postMessage({ t: 'probe-freeze', id, seq } satisfies MainToRender);
      },
      renew: () => {
        worker.postMessage({ t: 'probe-renew' } satisfies MainToRender);
      },
      unfreeze: (id) => {
        worker.postMessage({ t: 'probe-unfreeze', id } satisfies MainToRender);
      },
      synth: (id, series, points) =>
        new Promise<SynthAck>((resolve) => {
          this.synthWaits.push({ id, resolve });
          worker.postMessage({ t: 'probe-synth', id, series, points } satisfies MainToRender);
        }),
      chunk: (id) =>
        new Promise<ChunkInfo | null>((resolve) => {
          this.chunkWaits.push({ id, resolve });
          worker.postMessage({ t: 'probe-chunk', id } satisfies MainToRender);
        }),
      trap: () => {
        worker.postMessage({ t: 'probe-trap' } satisfies MainToRender);
      },
      inputLog: () =>
        new Promise<InputRec[]>((resolve) => {
          this.probeWaits.push((json) => {
            resolve(JSON.parse(json) as InputRec[]);
          });
          worker.postMessage({ t: 'probe-input' } satisfies MainToRender);
        }),
    };
  }

  createFrame(
    canvas: OffscreenCanvas,
    init: FrameInit,
    onFail: (reason: string) => void,
  ): WasmFrame {
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
      const frame = this.frames.get(ev.id)?.frame;
      // A disposed frame's events (a late `created` included) are ignored.
      if (ev.t === 'created') {
        if (this.ring !== null) frame?.created(this.ring);
        continue;
      }
      frame?.handle(ev);
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

  /** The probe build: a restart or a failure ends every pending `synth()` and `chunk()`. */
  private failSynths(reason: 'restart' | 'fatal'): void {
    for (const w of this.synthWaits.splice(0)) w.resolve({ ok: false, bytes: 0, reason });
    for (const w of this.chunkWaits.splice(0)) w.resolve(null);
  }

  private async restart(): Promise<void> {
    this.restarted = true;
    this.state = 'restarting';
    this.failSynths('restart');
    this.render?.terminate();
    this.ring?.close();
    this.ring = null;
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
    this.failSynths('fatal');
    this.queue.length = 0;
    this.render?.terminate();
    this.ring?.close();
    this.ring = null;
    showStatus(4);
    this.o.markFailed();
    const all = [...this.frames.values()];
    this.frames.clear();
    for (const e of all) e.onFail('trap');
  }
}

export async function loadBackend(o: EngineOptions): Promise<Backend> {
  const module = await (o.compile ?? compileEngine)(o.mode ?? 'mt');
  const host = new EngineHost(o, module);
  await host.boot();
  return host;
}
