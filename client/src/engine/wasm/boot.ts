/**
 * Boots the render worker (plan #68 C1 §4.1, T03 §4.2): `boot` with the compiled `Module`, then
 * the first `status`. On status 1 or 2 the render worker starts the rayon pool, asking for each
 * pool thread with `spawn-pool{ptr}`; this module starts a pool worker on the same module and
 * shared memory for each. No status within the timeout counts as Failed. The main thread never
 * instantiates the module (T03-003).
 *
 * Plan #68 C2d2: in ST (`mode: 'st'`) the boot message has no pool size, no pool worker is ever
 * started, and the worker's `input-ack` messages go to `onInputAck`.
 */
import {
  BOOT_TIMEOUT_MS,
  CAP_DPCB,
  CAP_ISOLATED,
  CAP_OFFSCREEN,
  CAP_WAIT_ASYNC,
  CAP_WEBGPU,
} from './layout.gen';
import type { MainToRender, PoolMessage, RenderToMain } from './protocol';

/** What the adapter needs of a `Worker` (tests pass fakes). */
export interface WorkerLike {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  addEventListener(type: 'message' | 'error', cb: (e: unknown) => void): void;
}

export type Status = Extract<RenderToMain, { t: 'status' }>;

export interface RenderOptions {
  readonly module: WebAssembly.Module;
  readonly forceT2: boolean;
  /** Plan #68 C2d2: the shared-memory engine or the single-thread one (default `mt`). */
  readonly mode?: 'mt' | 'st';
  readonly fault: string | undefined;
  readonly spawnRender: () => WorkerLike;
  readonly spawnPool: () => WorkerLike;
  readonly timeoutMs: number;
  /** `events` from the render worker. */
  readonly onEvents: (json: string) => void;
  /** An uncaught error in the render worker (a trap). */
  readonly onError: (e: unknown) => void;
  /** ST: the worker returned a batch (`input-ack`). */
  readonly onInputAck?: (m: Extract<RenderToMain, { t: 'input-ack' }>) => void;
  /** Plan #68 D2: the boot epoch the worker's chunk references carry (default 1). */
  readonly epoch?: number;
  /** Plan #68 D2 (MT): `decode-credit`, `decoded`, `decode-failed`, `chunk-missing`, `chunk-stats`. */
  readonly onDecode?: (
    m: Extract<
      RenderToMain,
      { t: 'decode-credit' | 'decoded' | 'decode-failed' | 'chunk-missing' | 'chunk-stats' }
    >,
  ) => void;
  /** The probe build: the input ring's start (`BootMessage.ringStart`). */
  readonly ringStart?: number;
  /** The probe build: the worker's `probe-input` reply. */
  readonly onProbeInput?: (json: string) => void;
  /** The probe build (plan #68 C2d1 §3.2): the worker's `probe-synth` acknowledgement. */
  readonly onProbeSynth?: (m: Extract<RenderToMain, { t: 'probe-synth' }>) => void;
  /** The probe build: the worker's `probe-chunk` answer. */
  readonly onProbeChunk?: (m: Extract<RenderToMain, { t: 'probe-chunk' }>) => void;
}

export interface RenderHandle {
  readonly worker: WorkerLike;
  /** The first status, or null when none came in time. */
  readonly status: Promise<Status | null>;
  /** Ends the render and pool workers. */
  terminate(): void;
}

/** `clamp(hwc − 3 − clamp(⌊hwc/4⌋, 1, 3), 1, 6)`: the pool beside render, data and main. */
export function poolSize(hwc: number): number {
  const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
  return clamp(hwc - 3 - clamp(Math.floor(hwc / 4), 1, 3), 1, 6);
}

/** The T03 §9.1 capability bits of this page (WebGL2 is probed by the render worker). */
export function capabilityBits(): number {
  const g = globalThis as typeof globalThis & { crossOriginIsolated?: boolean };
  let bits = 0;
  if (g.crossOriginIsolated ?? false) bits |= CAP_ISOLATED;
  if (
    typeof HTMLCanvasElement !== 'undefined' &&
    'transferControlToOffscreen' in HTMLCanvasElement.prototype
  ) {
    bits |= CAP_OFFSCREEN;
  }
  if (typeof navigator !== 'undefined' && 'gpu' in navigator) bits |= CAP_WEBGPU;
  if (typeof (Atomics as { waitAsync?: unknown }).waitAsync === 'function') bits |= CAP_WAIT_ASYNC;
  if (
    typeof ResizeObserverEntry !== 'undefined' &&
    'devicePixelContentBoxSize' in ResizeObserverEntry.prototype
  ) {
    bits |= CAP_DPCB;
  }
  return bits;
}

/** The fault of each boot (fault builds only; a release build drops this block). */
export async function bootFaults(): Promise<(restart: boolean) => string | undefined> {
  if (import.meta.env.VITE_ENGINE_FAULTS === '1') {
    const f = await import('../faults');
    const search = typeof location === 'undefined' ? '' : location.search;
    const site = f.installFaults('__pulsus_engine_fault__:boot', f.faultOf(search));
    return (restart) => site.bootFault(restart);
  }
  return () => undefined;
}

export function startRender(o: RenderOptions): RenderHandle {
  const st = o.mode === 'st';
  const worker = o.spawnRender();
  const pools: WorkerLike[] = [];
  let memory: WebAssembly.Memory | null = null;
  let settle: (s: Status | null) => void = () => undefined;
  const status = new Promise<Status | null>((resolve) => {
    settle = resolve;
  });
  const timer = setTimeout(() => {
    settle(null);
  }, o.timeoutMs);
  worker.addEventListener('message', (e) => {
    const m = (e as MessageEvent<RenderToMain>).data;
    switch (m.t) {
      case 'status':
        clearTimeout(timer);
        memory = m.memory ?? null;
        settle(m);
        return;
      case 'input-ack':
        o.onInputAck?.(m);
        return;
      case 'decode-credit':
      case 'decoded':
      case 'decode-failed':
      case 'chunk-missing':
      case 'chunk-stats':
        o.onDecode?.(m);
        return;
      case 'spawn-pool': {
        if (memory === null || st) return;
        const p = o.spawnPool();
        pools.push(p);
        const msg: PoolMessage = { t: 'pool', module: o.module, memory, ptr: m.ptr };
        p.postMessage(msg);
        return;
      }
      case 'events':
        o.onEvents(m.json);
        return;
      case 'probe-input':
        o.onProbeInput?.(m.json);
        return;
      case 'probe-synth':
        o.onProbeSynth?.(m);
        return;
      case 'probe-chunk':
        o.onProbeChunk?.(m);
        return;
    }
  });
  worker.addEventListener('error', (e) => {
    clearTimeout(timer);
    settle(null);
    o.onError(e);
  });
  const boot: MainToRender = {
    t: 'boot',
    module: o.module,
    forceT2: o.forceT2,
    mode: st ? 'st' : 'mt',
    caps: capabilityBits(),
    mainTimeOrigin: typeof performance === 'undefined' ? 0 : performance.timeOrigin,
    epoch: o.epoch ?? 1,
    ...(st
      ? {}
      : {
          pool: poolSize(typeof navigator === 'undefined' ? 4 : navigator.hardwareConcurrency || 4),
        }),
    ...(o.fault === undefined ? {} : { fault: o.fault }),
    ...(o.ringStart === undefined || st ? {} : { ringStart: o.ringStart }),
  };
  worker.postMessage(boot);
  return {
    worker,
    status,
    terminate() {
      clearTimeout(timer);
      worker.terminate();
      for (const p of pools.splice(0)) p.terminate();
    },
  };
}

export { BOOT_TIMEOUT_MS };
