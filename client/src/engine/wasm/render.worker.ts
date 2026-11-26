/**
 * The render worker (plan #68 C1 §4.1, §4.2; T03 §4.2): instantiates the engine on a new shared
 * memory, starts the GPU (`engine_start`) and the rayon pool, applies the frame messages and runs
 * the frame loop on the worker's animation frames: each `engine_tick` builds, draws and presents
 * the dirty frames and returns their events, posted as one `events` message. Worker times are
 * reported on the main thread's time origin.
 *
 * Part C2a1 (§4.2): the camera and the size arrive in the input ring, which `engine_tick` reads
 * first; `input` (posted by the adapter after a publish while this worker was idle) only wakes
 * the loop. The probe build (`VITE_ENGINE_PROBE=1`, `e2e:shim-fuzz` only) answers `probe-input`
 * with the decoded records and starts the ring's counters at `ringStart`; `probe-freeze` and
 * `probe-unfreeze` hold a frame after one presentation (plan #68 C2b §3.4).
 */
import init, {
  engine_on_wake,
  engine_start,
  engine_tick,
  engine_wants_frame,
  frame_create,
  frame_data_begin,
  frame_data_clear,
  frame_data_end,
  frame_data_series,
  frame_dispose,
  frame_set_spec,
  frame_set_events,
  frame_set_theme,
  pool_start,
} from 'virtual:dash-engine';
import { frameLoop } from './loop';
import type { BootMessage, MainToRender, RenderToMain, SeriesMessage } from './protocol';

interface Scope {
  postMessage(msg: RenderToMain): void;
  addEventListener(type: 'message', cb: (e: MessageEvent<MainToRender>) => void): void;
  requestAnimationFrame(cb: () => void): number;
}

/** The probe build's exports (`--features probe`; not in the committed release `.d.ts`). */
interface ProbeExports {
  engine_probe_input(): string;
  engine_probe_ring_start(v: number): void;
  /** Plan #68 C2b §3.4. */
  engine_probe_freeze?(id: number, seq: number): void;
  engine_probe_unfreeze?(id: number): void;
}

interface Faults {
  failCreate(id: number): boolean;
  series(id: number, s: readonly SeriesMessage[]): readonly SeriesMessage[];
  afterEvents(json: string): void;
}

const scope = self as unknown as Scope;
let booted = false;
const early: MainToRender[] = [];
let shift = 0;
let faults: Faults | null = null;
/** Frames whose data or spec failed: logged once each. */
const logged = new Set<string>();

function logOnce(what: string, id: number, e: unknown): void {
  const key = `${what}:${String(id)}`;
  if (logged.has(key)) return;
  logged.add(key);
  console.error(
    `pulsus engine: frame ${String(id)} ${what}: ${e instanceof Error ? e.message : String(e)}`,
  );
}

/** One tick: the engine's events, posted; whether another frame is wanted. */
function tick(): boolean {
  const json = engine_tick(performance.now() + shift);
  if (json !== '') {
    scope.postMessage({ t: 'events', json });
    faults?.afterEvents(json);
  }
  return engine_wants_frame();
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
    case 'probe-input':
      if (import.meta.env.VITE_ENGINE_PROBE === '1') void probeInput();
      return;
    case 'probe-freeze':
    case 'probe-unfreeze':
      if (import.meta.env.VITE_ENGINE_PROBE === '1') void probeFreeze(m);
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
        frame_create(m.id, m.canvas, m.frameId);
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
        frame_set_spec(m.id, m.json);
      } catch (e) {
        logOnce('spec', m.id, e);
      }
      break;
    case 'data':
      if (m.series === null) {
        frame_data_clear(m.id);
        break;
      }
      try {
        frame_data_begin(m.id);
        for (const s of faults?.series(m.id, m.series) ?? m.series) {
          frame_data_series(m.id, s.key, [...s.names], [...s.values], s.t, s.v);
        }
        frame_data_end(m.id);
      } catch (e) {
        logOnce('data', m.id, e);
        frame_data_clear(m.id);
      }
      break;
    case 'theme':
      frame_set_theme(m.id, m.theme);
      break;
    case 'events':
      frame_set_events(m.id, m.atMs);
      break;
    case 'dispose':
      frame_dispose(m.id);
      return;
  }
  schedule();
}

/** The probe build: hold a frame after a presentation, or release it (plan #68 C2b §3.4). */
async function probeFreeze(
  m: Extract<MainToRender, { t: 'probe-freeze' } | { t: 'probe-unfreeze' }>,
): Promise<void> {
  const p = (await import('virtual:dash-engine')) as unknown as ProbeExports;
  if (m.t === 'probe-freeze') p.engine_probe_freeze?.(m.id, m.seq >>> 0);
  else p.engine_probe_unfreeze?.(m.id);
  schedule();
}

/** The probe build: the decoded records, posted back. */
async function probeInput(): Promise<void> {
  const p = (await import('virtual:dash-engine')) as unknown as ProbeExports;
  scope.postMessage({ t: 'probe-input', json: p.engine_probe_input() });
}

async function boot(m: BootMessage): Promise<void> {
  if (import.meta.env.VITE_ENGINE_FAULTS === '1') {
    const f = await import('../faults');
    faults = f.installFaults('__pulsus_engine_fault__:worker', f.asFault(m.fault));
  }
  shift = performance.timeOrigin - m.mainTimeOrigin;
  const out = await init({ module_or_path: m.module });
  // The engine wakes the loop itself after a device loss or a restore while idle.
  engine_on_wake(schedule);
  const st = await engine_start(m.forceT2, m.caps, 1);
  if (import.meta.env.VITE_ENGINE_PROBE === '1' && m.ringStart !== undefined) {
    const p = (await import('virtual:dash-engine')) as unknown as ProbeExports;
    p.engine_probe_ring_start(m.ringStart);
  }
  scope.postMessage({
    t: 'status',
    status: st.status,
    adapter: st.adapter,
    cb: st.cb,
    memory: out.memory,
  });
  if (st.status === 1 || st.status === 2) {
    pool_start(m.pool, (ptr: number) => {
      scope.postMessage({ t: 'spawn-pool', ptr });
    });
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
