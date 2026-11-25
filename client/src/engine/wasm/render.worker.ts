/**
 * The render worker (plan #68 C1 §4.1, §4.2; T03 §4.2): instantiates the engine on a new shared
 * memory, starts the GPU (`engine_start`) and the rayon pool, applies the frame messages and runs
 * the frame loop on the worker's animation frames: each `engine_tick` builds, draws and presents
 * the dirty frames and returns their events, posted as one `events` message. Worker times are
 * reported on the main thread's time origin.
 */
import init, {
  engine_start,
  engine_tick,
  engine_wants_frame,
  frame_create,
  frame_data_begin,
  frame_data_clear,
  frame_data_end,
  frame_data_series,
  frame_dispose,
  frame_resize,
  frame_set_spec,
  frame_set_theme,
  frame_set_window,
  pool_start,
} from 'virtual:dash-engine';
import type { BootMessage, MainToRender, RenderToMain, SeriesMessage } from './protocol';

interface Scope {
  postMessage(msg: RenderToMain): void;
  addEventListener(type: 'message', cb: (e: MessageEvent<MainToRender>) => void): void;
  requestAnimationFrame(cb: () => void): number;
}

interface Faults {
  failCreate(m: Extract<MainToRender, { t: 'create' }>): boolean;
  data(id: number, s: readonly SeriesMessage[]): readonly SeriesMessage[];
  afterEvents(json: string): void;
}

const scope = self as unknown as Scope;
let booted = false;
const early: MainToRender[] = [];
let shift = 0;
let raf = 0;
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

function schedule(): void {
  if (raf === 0) raf = scope.requestAnimationFrame(tick);
}

function tick(): void {
  raf = 0;
  const json = engine_tick(performance.now() + shift);
  if (json !== '') {
    scope.postMessage({ t: 'events', json });
    faults?.afterEvents(json);
  }
  if (engine_wants_frame()) schedule();
}

function apply(m: MainToRender): void {
  switch (m.t) {
    case 'boot':
      return;
    case 'create':
      if (faults?.failCreate(m) === true) {
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
        for (const s of faults?.data(m.id, m.series) ?? m.series) {
          frame_data_series(m.id, s.key, [...s.names], [...s.values], s.t, s.v);
        }
        frame_data_end(m.id);
      } catch (e) {
        logOnce('data', m.id, e);
        frame_data_clear(m.id);
      }
      break;
    case 'window':
      frame_set_window(m.id, m.from, m.to);
      break;
    case 'theme':
      frame_set_theme(m.id, m.theme);
      break;
    case 'resize':
      frame_resize(m.id, m.w, m.h, m.dpr);
      break;
    case 'dispose':
      frame_dispose(m.id);
      return;
  }
  schedule();
}

async function boot(m: BootMessage): Promise<void> {
  if (import.meta.env.VITE_ENGINE_FAULTS === '1' && m.fault !== undefined) {
    const f = await import('./faults');
    faults = new f.WorkerFaults(m.fault);
  }
  shift = performance.timeOrigin - m.mainTimeOrigin;
  const out = await init({ module_or_path: m.module });
  const st = await engine_start(m.forceT2, m.caps, 1);
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
