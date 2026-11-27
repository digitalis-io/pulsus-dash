/**
 * The render worker's logic, shared by both engines (plan #68 C1 §4.1, §4.2; T03 §4.2; plan #68
 * C2d2 §1): instantiates the engine, starts the GPU (`engine_start`), applies the frame messages
 * and runs the frame loop on the worker's animation frames: each `engine_tick` builds, draws and
 * presents the dirty frames and returns their events, posted as one `events` message. Worker times
 * are reported on the main thread's time origin. `render.worker.ts` (MT) and `render-st.worker.ts`
 * (ST) differ only in their bindings and boot.
 *
 * MT (Part C2a1, §4.2): the engine runs on a new shared memory, the rayon pool is started, and the
 * camera and the size arrive in the input ring, which `engine_tick` reads first; `input` (posted by
 * the adapter after a publish while this worker was idle) only wakes the loop.
 *
 * ST (plan #68 C2d2 §3.2): the engine has its own memory and no pool. Input comes as `input-batch`
 * messages: the buffer is held, its records are queued in the engine (`engine_input_batch`) and the
 * loop is woken; after the tick that applied them, the buffer goes back in `input-ack` with the
 * number of batches held at once (`depth`, 1) and the engine's `INPUT_BAD` count. The `status`
 * carries no memory.
 *
 * The probe build (`VITE_ENGINE_PROBE=1`) answers `probe-input` with the decoded records and starts
 * the ring's counters at `ringStart`; `probe-freeze` and `probe-unfreeze` hold a frame after one
 * presentation (plan #68 C2b §3.4); `probe-synth` builds F1c as a frame's data and acknowledges it
 * (plan #68 C2d1 §3.2).
 *
 * Plan #68 D2 (§3.1, MT): `decode-begin`, `decode-chunk` (each read's bytes), `decode-end` and
 * `decode-abort` feed the engine's decode service; this worker never decodes, the pool does. At
 * each tick start the service's results (`engine_decode_take`) are posted: `decode-credit`,
 * `decoded` (the head parsed here, `ts` and `vs` transferred) and `decode-failed`. `data-chunk`
 * makes a table chunk a frame's data, else `chunk-missing`; `chunk-release` drops an entry.
 */
import { frameLoop } from './loop';
import { CB_BYTES, OFF_INPUT_BAD } from './layout.gen';
import type {
  BootMessage,
  DecodeFailKind,
  DecodedHeadWire,
  MainToRender,
  RenderToMain,
  SeriesMessage,
} from './protocol';

interface Scope {
  postMessage(msg: RenderToMain, transfer?: Transferable[]): void;
  addEventListener(type: 'message', cb: (e: MessageEvent<MainToRender>) => void): void;
  requestAnimationFrame(cb: () => void): number;
}

/** `engine_start`'s result. */
interface BootStatusLike {
  readonly status: number;
  readonly cb: number;
  readonly adapter: string;
}

/** The engine exports both modes have (`dash_core_mt.d.ts`, `dash_core_st.d.ts`). */
export interface RenderBindings {
  readonly mode: 'mt' | 'st';
  init(o: { module_or_path: WebAssembly.Module }): Promise<{ memory: WebAssembly.Memory }>;
  engine_on_wake(wake: () => void): void;
  engine_start(forceT2: boolean, caps: number, epoch: number): Promise<BootStatusLike>;
  engine_tick(nowMs: number): string;
  engine_wants_frame(): boolean;
  frame_create(id: number, canvas: OffscreenCanvas, frameId?: string | null): void;
  frame_data_begin(id: number): void;
  frame_data_clear(id: number): void;
  frame_data_end(id: number): void;
  frame_data_series(
    id: number,
    key: string,
    names: string[],
    values: string[],
    t: Float64Array,
    v: Float64Array,
  ): void;
  frame_dispose(id: number): void;
  frame_set_spec(id: number, json: string): void;
  frame_set_events(id: number, atMs: Float64Array): void;
  frame_set_selection(
    id: number,
    keys: string[],
    fromMs?: number | null,
    toMs?: number | null,
  ): void;
  frame_set_theme(id: number, theme: number): void;
  /** MT: the rayon pool. */
  readonly pool_start?: (threads: number, spawn: (ptr: number) => void) => void;
  /** ST: one input batch's records queued; returns how many. */
  readonly engine_input_batch?: (bytes: Uint8Array) => number;
  /** MT (plan #68 D2): the decode service and the chunk table. */
  readonly engine_decode_begin?: (req: number) => void;
  readonly engine_decode_chunk?: (req: number, bytes: Uint8Array) => void;
  readonly engine_decode_end?: (req: number) => void;
  readonly engine_decode_abort?: (req: number) => void;
  readonly engine_decode_take?: () => unknown[];
  readonly frame_set_chunk_ref?: (id: number, chunk: number, epoch: number) => boolean;
  readonly engine_chunk_release?: (chunk: number, epoch: number) => void;
  readonly engine_chunk_stats?: () => string;
  /** The probe build's exports (the same module, loaded again). */
  probe(): Promise<ProbeExports>;
}

/** The probe build's exports (`--features probe`; not in the committed release `.d.ts`). */
export interface ProbeExports {
  engine_probe_input(): string;
  engine_probe_ring_start(v: number): void;
  /** Plan #68 C2b §3.4. */
  engine_probe_freeze?(id: number, seq: number): void;
  engine_probe_unfreeze?(id: number): void;
  engine_probe_renew?(): void;
  /** Plan #68 C2d1 §3.2: bytes of values held, 0 = failed. */
  engine_probe_synth?(id: number, series: number, points: number): number;
  /** `{series, points, bytes}` JSON of the frame's chunk, or `null`. */
  engine_probe_chunk?(id: number): string;
}

interface Faults {
  failCreate(id: number): boolean;
  series(id: number, s: readonly SeriesMessage[]): readonly SeriesMessage[];
  afterEvents(json: string): void;
}

/** Runs the render worker on `b` in this worker scope. */
export function runRender(b: RenderBindings): void {
  const scope = self as unknown as Scope;
  let booted = false;
  const early: MainToRender[] = [];
  let shift = 0;
  let faults: Faults | null = null;
  /** Frames whose data or spec failed: logged once each. */
  const logged = new Set<string>();
  /** ST: the engine's memory and control block (its `INPUT_BAD`). */
  let memory: WebAssembly.Memory | null = null;
  let cb = 0;
  /** ST: the batch buffers whose records are queued, not yet applied by a tick. */
  const held: ArrayBuffer[] = [];

  function logOnce(what: string, id: number, e: unknown): void {
    const key = `${what}:${String(id)}`;
    if (logged.has(key)) return;
    logged.add(key);
    console.error(
      `pulsus engine: frame ${String(id)} ${what}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  /** ST: the engine's `INPUT_BAD` (its own memory, this thread). */
  function bad(): number {
    if (memory === null || cb + CB_BYTES > memory.buffer.byteLength) return 0;
    return new DataView(memory.buffer).getUint32(cb + OFF_INPUT_BAD, true);
  }

  /** Plan #68 D2: the decode service's results since the last tick, posted. */
  function postDecodes(): void {
    const done = b.engine_decode_take?.() ?? [];
    for (const raw of done) {
      const d = raw as {
        t: string;
        req: number;
        bytes?: number;
        chunk?: number;
        epoch?: number;
        head?: string;
        ts?: Float64Array;
        vs?: Float64Array[];
        kind?: DecodeFailKind;
        message?: string;
        row?: string | null;
        coverage?: string | null;
        planned?: string | null;
      };
      if (d.t === 'decode-credit') {
        scope.postMessage({ t: 'decode-credit', req: d.req, bytes: d.bytes ?? 0 });
      } else if (d.t === 'decoded' && d.ts !== undefined && d.vs !== undefined) {
        const head = JSON.parse(d.head ?? 'null') as DecodedHeadWire;
        scope.postMessage(
          {
            t: 'decoded',
            req: d.req,
            chunk: d.chunk ?? 0,
            epoch: d.epoch ?? 0,
            head,
            ts: d.ts,
            vs: d.vs,
          },
          [d.ts.buffer, ...d.vs.map((v) => v.buffer)],
        );
      } else if (d.t === 'decode-failed') {
        const parse = (j: string | null | undefined): unknown =>
          j === null || j === undefined ? null : JSON.parse(j);
        scope.postMessage({
          t: 'decode-failed',
          req: d.req,
          kind: d.kind ?? 'invalid',
          message: d.message ?? '',
          row: parse(d.row),
          coverage: parse(d.coverage),
          planned: d.planned ?? null,
        });
      }
    }
  }

  /** One tick: the decodes' results and the engine's events, posted; then (ST) each applied batch returned. */
  function tick(): boolean {
    postDecodes();
    const applied = held.splice(0);
    const json = b.engine_tick(performance.now() + shift);
    if (json !== '') {
      scope.postMessage({ t: 'events', json });
      faults?.afterEvents(json);
    }
    if (applied.length > 0) {
      const n = bad();
      for (const buf of applied) {
        scope.postMessage({ t: 'input-ack', buf, depth: applied.length, bad: n }, [buf]);
      }
    }
    return held.length > 0 || b.engine_wants_frame();
  }

  const loop = frameLoop({ tick, requestFrame: (cb) => scope.requestAnimationFrame(cb) });

  function schedule(): void {
    loop.wake();
  }

  function apply(m: MainToRender): void {
    switch (m.t) {
      case 'boot':
        return;
      case 'input':
        break;
      case 'decode-begin':
        b.engine_decode_begin?.(m.req);
        break;
      case 'decode-chunk':
        b.engine_decode_chunk?.(m.req, new Uint8Array(m.buf));
        break;
      case 'decode-end':
        b.engine_decode_end?.(m.req);
        break;
      case 'decode-abort':
        b.engine_decode_abort?.(m.req);
        break;
      case 'data-chunk':
        if (b.frame_set_chunk_ref?.(m.id, m.chunk, m.epoch) !== true) {
          scope.postMessage({ t: 'chunk-missing', id: m.id, chunk: m.chunk });
          return;
        }
        break;
      case 'chunk-release':
        b.engine_chunk_release?.(m.chunk, m.epoch);
        return;
      case 'chunk-stats':
        scope.postMessage({ t: 'chunk-stats', json: b.engine_chunk_stats?.() ?? 'null' });
        return;
      case 'input-batch':
        // ST: queued now, applied at the next tick start, acknowledged after that tick.
        b.engine_input_batch?.(new Uint8Array(m.buf, 0, m.len));
        held.push(m.buf);
        break;
      case 'probe-input':
        if (import.meta.env.VITE_ENGINE_PROBE === '1') void probeInput();
        return;
      case 'probe-freeze':
      case 'probe-unfreeze':
        if (import.meta.env.VITE_ENGINE_PROBE === '1') void probeFreeze(m);
        return;
      case 'probe-renew':
        if (import.meta.env.VITE_ENGINE_PROBE === '1') void probeRenew();
        return;
      case 'probe-synth':
        if (import.meta.env.VITE_ENGINE_PROBE === '1') void probeSynth(m);
        return;
      case 'probe-chunk':
        if (import.meta.env.VITE_ENGINE_PROBE === '1') void probeChunk(m.id);
        return;
      case 'probe-trap':
        if (import.meta.env.VITE_ENGINE_PROBE === '1') {
          // Uncaught, as a trap: the worker's error event (plan #68 C2d1, the bench's failure test).
          setTimeout(() => {
            throw new Error('probe trap');
          }, 0);
        }
        return;
      case 'create':
        if (faults?.failCreate(m.id) === true) {
          scope.postMessage({
            t: 'events',
            json: JSON.stringify([{ t: 'failed', id: m.id, reason: 'surface' }]),
          });
          return;
        }
        try {
          b.frame_create(m.id, m.canvas, m.frameId);
        } catch (e) {
          logOnce('create', m.id, e);
          scope.postMessage({
            t: 'events',
            json: JSON.stringify([{ t: 'failed', id: m.id, reason: 'surface' }]),
          });
        }
        break;
      case 'spec':
        try {
          b.frame_set_spec(m.id, m.json);
        } catch (e) {
          logOnce('spec', m.id, e);
        }
        break;
      case 'data':
        if (m.series === null) {
          b.frame_data_clear(m.id);
          break;
        }
        try {
          b.frame_data_begin(m.id);
          for (const s of faults?.series(m.id, m.series) ?? m.series) {
            b.frame_data_series(m.id, s.key, [...s.names], [...s.values], s.t, s.v);
          }
          b.frame_data_end(m.id);
        } catch (e) {
          logOnce('data', m.id, e);
          b.frame_data_clear(m.id);
        }
        break;
      case 'theme':
        b.frame_set_theme(m.id, m.theme);
        break;
      case 'events':
        b.frame_set_events(m.id, m.atMs);
        break;
      case 'selection':
        b.frame_set_selection(m.id, [...m.keys], m.fromMs, m.toMs);
        break;
      case 'dispose':
        b.frame_dispose(m.id);
        return;
    }
    schedule();
  }

  /** The probe build: hold a frame after a presentation, or release it (plan #68 C2b §3.4). */
  async function probeFreeze(
    m: Extract<MainToRender, { t: 'probe-freeze' } | { t: 'probe-unfreeze' }>,
  ): Promise<void> {
    const p = await b.probe();
    if (m.t === 'probe-freeze') p.engine_probe_freeze?.(m.id, m.seq >>> 0);
    else p.engine_probe_unfreeze?.(m.id);
    schedule();
  }

  /** The probe build (plan #68 C2c2 S11): every renderer made again, then a frame loop tick. */
  async function probeRenew(): Promise<void> {
    const p = await b.probe();
    p.engine_probe_renew?.();
    schedule();
  }

  /**
   * The probe build (plan #68 C2d1 §3.2): F1c built as the frame's data, acknowledged with the
   * bytes of values it holds (0, `ok: false`: an allocation failed and the frame is unchanged).
   */
  async function probeSynth(m: Extract<MainToRender, { t: 'probe-synth' }>): Promise<void> {
    const p = await b.probe();
    const bytes = p.engine_probe_synth?.(m.id, m.series >>> 0, m.points >>> 0) ?? 0;
    scope.postMessage({ t: 'probe-synth', id: m.id, ok: bytes > 0, bytes });
    schedule();
  }

  /** The probe build (plan #68 C2d1 §3.2): the frame's chunk described, posted back. */
  async function probeChunk(id: number): Promise<void> {
    const p = await b.probe();
    scope.postMessage({ t: 'probe-chunk', id, json: p.engine_probe_chunk?.(id) ?? 'null' });
  }

  /** The probe build: the decoded records, posted back. */
  async function probeInput(): Promise<void> {
    const p = await b.probe();
    scope.postMessage({ t: 'probe-input', json: p.engine_probe_input() });
  }

  async function boot(m: BootMessage): Promise<void> {
    if (import.meta.env.VITE_ENGINE_FAULTS === '1') {
      const f = await import('../faults');
      faults = f.installFaults('__pulsus_engine_fault__:worker', f.asFault(m.fault));
    }
    shift = performance.timeOrigin - m.mainTimeOrigin;
    const out = await b.init({ module_or_path: m.module });
    // The engine wakes the loop itself after a device loss or a restore while idle.
    b.engine_on_wake(schedule);
    const st = await b.engine_start(m.forceT2, m.caps, m.epoch ?? 1);
    if (import.meta.env.VITE_ENGINE_PROBE === '1' && m.ringStart !== undefined) {
      (await b.probe()).engine_probe_ring_start(m.ringStart);
    }
    if (b.mode === 'st') {
      memory = out.memory;
      cb = st.cb;
      scope.postMessage({ t: 'status', status: st.status, adapter: st.adapter, cb: st.cb });
    } else {
      scope.postMessage({
        t: 'status',
        status: st.status,
        adapter: st.adapter,
        cb: st.cb,
        memory: out.memory,
      });
      if ((st.status === 1 || st.status === 2) && b.pool_start !== undefined) {
        b.pool_start(m.pool ?? 1, (ptr: number) => {
          scope.postMessage({ t: 'spawn-pool', ptr });
        });
      }
    }
    booted = true;
    for (const e of early.splice(0)) apply(e);
  }

  scope.addEventListener('message', (e) => {
    const m = e.data;
    if (m.t === 'boot') {
      void boot(m);
      return;
    }
    if (!booted) {
      early.push(m);
      return;
    }
    apply(m);
  });
}
