/**
 * The routing engine (plan #68 C1 §3.4, §4.1, §4.3; D-ROUTE): one routing frame per ChartFrame,
 * bound to a backend when its first spec arrives. A line frame goes to the WASM engine once it
 * has booted (status 1 or 2: the canvas is transferred); any other kind, or a failed boot, goes
 * to Canvas 2D on the same canvas. A WASM frame whose spec changes to another kind swaps to
 * Canvas 2D on a fresh canvas, without a notice, and stays there (the kind swap); a Canvas 2D
 * frame stays on Canvas 2D whatever its kind.
 *
 * The routing frame keeps the frame's latest state (spec, data, window, theme, events, selection,
 * size) and its listeners, so it can replay them into a backend at bind, after a fallback and
 * after an engine restart. A fallback or restart needs a fresh `<canvas>` (a transferred one has
 * no 2D context, and is committed to its worker): the fresh canvas goes after the current one,
 * which stays for ChartFrame's reference, retired and hidden; its title and class are mirrored
 * to the live canvas. A notice tells the user. Dispose removes what this frame created; ChartFrame
 * removes its own canvas. Unbinding a frame whose last forwarded hover was shown (a restart, a
 * fallback, the kind swap) emits `hover: null` once (plan #68 C2b §4.4).
 */
import { t } from '../i18n/t';
import { faultOf, installFaults, type FaultSite } from './faults';
import type {
  ChartEngine,
  ChartFrame,
  EventMarker,
  FrameData,
  FrameEvents,
  FrameInit,
  FrameSelection,
  ThemeName,
  TimeWindow,
  VisSpec,
} from './api';
import { ControlledFrame } from './controlled';
import styles from './route.module.css';
import type { EngineFrame } from './wasm/frame';

/**
 * The WASM engine as the routing frames use it (`wasm/engine.ts`). `onFail` reasons: `surface`
 * and `readback` (this frame falls back), `restart` (the engine restarted: bind again on a fresh
 * canvas), `trap` (the engine is gone for the session: every frame falls back).
 */
export interface WasmBackend {
  readonly tier: 't1' | 't2';
  createFrame(
    canvas: OffscreenCanvas,
    init: FrameInit,
    onFail: (reason: string) => void,
  ): EngineFrame;
}

/**
 * Every `FrameEvents` key, forwarded from the bound frame (a `Record`, so a new event cannot be
 * left out: `mark` and `pick` were, plan #68 C2a1).
 */
const FORWARDED: Readonly<Record<keyof FrameEvents, true>> = {
  hover: true,
  brush: true,
  select: true,
  a11y: true,
  drawn: true,
  commit: true,
  mark: true,
  pick: true,
};
const EVENTS = Object.keys(FORWARDED) as (keyof FrameEvents)[];

type Listener = (ev: never) => void;

/** The route site's faults (fault builds only; a release build drops this block). */
let faults: FaultSite | null = null;
if (import.meta.env.VITE_ENGINE_FAULTS === '1') {
  faults = installFaults(
    '__pulsus_engine_fault__:route',
    faultOf(typeof location === 'undefined' ? '' : location.search),
  );
}

interface State {
  spec?: VisSpec;
  data?: FrameData;
  window?: TimeWindow;
  theme?: ThemeName;
  events: readonly EventMarker[];
  selection: FrameSelection | null;
  size?: readonly [number, number, number];
}

export class RoutingEngine implements ChartEngine {
  private backend: Promise<WasmBackend | null> | null = null;
  private dead = false;

  constructor(
    private readonly load: () => Promise<WasmBackend>,
    private readonly canvas2d: ChartEngine,
  ) {}

  createFrame(canvas: HTMLCanvasElement, init: FrameInit): ChartFrame {
    this.backend ??= this.load().catch((e: unknown) => {
      console.warn(`pulsus engine unavailable: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    });
    return new RoutingFrame(this, canvas, init);
  }

  /** The backend, or null when it did not boot or has failed for good. */
  backendNow(): Promise<WasmBackend | null> {
    if (this.dead || this.backend === null) return Promise.resolve(null);
    return this.backend.then((b) => (this.dead ? null : b));
  }

  isDead(): boolean {
    return this.dead;
  }

  /** A fatal engine failure: later frames go to Canvas 2D. */
  kill(): void {
    this.dead = true;
  }

  get fallback(): ChartEngine {
    return this.canvas2d;
  }
}

class RoutingFrame implements ChartFrame {
  private readonly state: State = { events: [], selection: null };
  private readonly listeners = new Map<keyof FrameEvents, Set<Listener>>();
  private inner: ChartFrame | null = null;
  private innerOffs: (() => void)[] = [];
  private mode: 'unbound' | 'binding' | 'bound' | 'disposed' = 'unbound';
  /** The backend of the bound frame. */
  private on2d = false;
  /** Bumped on every (re)bind: callbacks of an older backend frame are ignored. */
  private gen = 0;
  private live: HTMLCanvasElement;
  /** The last hover forwarded from the bound frame was not null. */
  private hoverShown = false;
  private readonly created: Element[] = [];
  private observer: MutationObserver | null = null;

  constructor(
    private readonly engine: RoutingEngine,
    private readonly original: HTMLCanvasElement,
    private readonly init: FrameInit,
  ) {
    this.live = original;
  }

  setSpec(spec: VisSpec): void {
    this.state.spec = spec;
    if (this.inner !== null && !this.on2d && spec.kind !== 'line') {
      // The kind swap: the engine draws lines only (until #69).
      this.unbind();
      this.bindCanvas2d(this.freshCanvas());
      return;
    }
    if (this.inner !== null) {
      this.inner.setSpec(spec);
      return;
    }
    if (this.mode !== 'unbound') return;
    if (spec.kind !== 'line' || this.engine.isDead()) {
      this.bindCanvas2d(this.live);
      return;
    }
    this.mode = 'binding';
    void this.engine.backendNow().then((b) => {
      if (this.mode !== 'binding') return;
      // The latest spec decides (review r1 #1): it may have left `line` while the engine booted.
      if (b === null || this.state.spec?.kind !== 'line') this.bindCanvas2d(this.live);
      else this.bindWasm(b, this.live);
    });
  }

  setData(data: FrameData): void {
    const d = faults === null ? data : faults.data(data);
    this.state.data = d;
    this.inner?.setData(d);
  }

  setTimeWindow(w: TimeWindow): void {
    this.state.window = w;
    this.inner?.setTimeWindow(w);
  }

  setTheme(theme: ThemeName): void {
    this.state.theme = theme;
    this.inner?.setTheme(theme);
  }

  setEvents(events: readonly EventMarker[]): void {
    this.state.events = events;
    this.inner?.setEvents(events);
  }

  setSelection(sel: FrameSelection | null): void {
    this.state.selection = sel;
    this.inner?.setSelection(sel);
  }

  /** Stub (#234 Part 1, tests first). */
  setFocusMark(id: string | null): void {
    void id;
  }

  /** Stub (#234 Part 1, tests first). */
  cameraKey(k: string): void {
    void k;
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.state.size = [cssWidth, cssHeight, dpr];
    this.inner?.resize(cssWidth, cssHeight, dpr);
  }

  on<E extends keyof FrameEvents>(e: E, cb: (ev: FrameEvents[E]) => void): () => void {
    let set = this.listeners.get(e);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(e, set);
    }
    const fn = cb as Listener;
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }

  dispose(): void {
    this.mode = 'disposed';
    this.unbind();
    this.observer?.disconnect();
    this.observer = null;
    for (const el of this.created.splice(0)) el.remove();
  }

  private emit<E extends keyof FrameEvents>(e: E, ev: FrameEvents[E]): void {
    for (const cb of [...(this.listeners.get(e) ?? [])]) (cb as (x: FrameEvents[E]) => void)(ev);
  }

  private unbind(): void {
    for (const off of this.innerOffs.splice(0)) off();
    this.inner?.dispose();
    this.inner = null;
    if (this.hoverShown) {
      this.hoverShown = false;
      // The frame's hover goes with it, unless the frame itself is going.
      if (this.mode !== 'disposed') this.emit('hover', null);
    }
  }

  /** Attaches `frame` and replays the state into it, in order. */
  private attach(frame: ChartFrame): void {
    this.inner = frame;
    this.mode = 'bound';
    for (const e of EVENTS) {
      this.innerOffs.push(
        frame.on(e, (ev) => {
          if (e === 'hover') this.hoverShown = ev !== null;
          this.emit(e, ev);
        }),
      );
    }
    const s = this.state;
    if (s.spec !== undefined) frame.setSpec(s.spec);
    if (s.data !== undefined) frame.setData(s.data);
    if (s.window !== undefined) frame.setTimeWindow(s.window);
    if (s.theme !== undefined) frame.setTheme(s.theme);
    frame.setEvents(s.events);
    frame.setSelection(s.selection);
    if (s.size !== undefined) frame.resize(...s.size);
  }

  private bindCanvas2d(canvas: HTMLCanvasElement): void {
    this.gen += 1;
    this.on2d = true;
    canvas.dataset['engine'] = 'canvas2d';
    try {
      this.attach(this.engine.fallback.createFrame(canvas, this.init));
    } catch (e) {
      this.mode = 'bound';
      console.warn(`pulsus chart: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private bindWasm(b: WasmBackend, canvas: HTMLCanvasElement): void {
    const gen = ++this.gen;
    this.on2d = false;
    const offscreen = canvas.transferControlToOffscreen();
    canvas.dataset['engine'] = b.tier === 't1' ? 'wasm-webgpu' : 'wasm-webgl2';
    const inner = b.createFrame(offscreen, this.init, (reason) => {
      if (gen === this.gen && this.mode === 'bound') this.onFail(b, reason);
    });
    this.attach(new ControlledFrame(canvas, this.init, inner));
  }

  /** A backend failure (plan #68 C1 §4.3): rebind on a fresh canvas, to the engine or Canvas 2D. */
  private onFail(b: WasmBackend, reason: string): void {
    this.unbind();
    if (reason === 'trap') this.engine.kill();
    const fresh = this.freshCanvas();
    if (reason === 'restart' && !this.engine.isDead()) this.bindWasm(b, fresh);
    else this.bindCanvas2d(fresh);
    this.notice();
  }

  /** Retires the live canvas and puts a fresh one after it. */
  private freshCanvas(): HTMLCanvasElement {
    const old = this.live;
    old.setAttribute('data-retired', '');
    old.hidden = true;
    old.setAttribute('aria-hidden', 'true');
    old.style.setProperty('display', 'none', 'important');
    const fresh = document.createElement('canvas');
    fresh.className = this.original.className;
    const role = this.original.getAttribute('role');
    if (role !== null) fresh.setAttribute('role', role);
    const label = this.original.getAttribute('aria-label');
    if (label !== null) fresh.setAttribute('aria-label', label);
    old.after(fresh);
    this.created.push(fresh);
    this.live = fresh;
    if (this.observer === null && typeof MutationObserver !== 'undefined') {
      this.observer = new MutationObserver(() => {
        const l = this.original.getAttribute('aria-label');
        if (l === null) this.live.removeAttribute('aria-label');
        else this.live.setAttribute('aria-label', l);
        this.live.className = this.original.className;
      });
      this.observer.observe(this.original, {
        attributes: true,
        attributeFilter: ['aria-label', 'class'],
      });
    }
    return fresh;
  }

  private notice(): void {
    if (this.created.some((el) => el.hasAttribute('data-engine-notice'))) return;
    const p = document.createElement('p');
    p.setAttribute('role', 'status');
    p.setAttribute('data-engine-notice', '');
    p.className = styles['notice'] ?? '';
    p.textContent = t('chart.engineRecovered');
    this.live.after(p);
    this.created.push(p);
  }
}
