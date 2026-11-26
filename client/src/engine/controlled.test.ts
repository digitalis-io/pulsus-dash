/**
 * `ControlledFrame` (plan #68 C2a2 §3.1, §3.2, §5; INT-002, INT-007, INT-008, ADR-0030): #93's
 * camera controller drives an engine frame from the main thread. The engine frame is a fake: its
 * stage is set by the test (the last completed presentation), and the cameras it is sent are
 * recorded. The controller acts only on a stage; a withdrawn stage aborts the gesture and restores
 * the committed camera, with no commit.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  BrushEvent,
  CommitEvent,
  EventMarker,
  FrameEvents,
  SelectEvent,
  TimeWindow,
  ValueRange,
  VisSpec,
} from './api';
import { timeLimits, toWindow, valueLimits, zoomAbout, type Span } from './canvas2d/camera';
import { brushSnapUnit } from './canvas2d/columns';
import { ControlledFrame } from './controlled';
import type { CameraState, EngineFrame, OverlayState, StageModel } from './wasm/frame';
import { lineData, LINE, T0, W0 } from '../test/cameraKit';
import { key, pointer, wheel } from '../test/engineHarness';

const S1: StageModel = {
  plot: { x: 50, y: 8, width: 900, height: 200 },
  valueDomain: { min: 0, max: 30 },
  labelW: 38,
  pickCount: 0,
};
const span = (w: TimeWindow): Span => ({ lo: w.fromMs, hi: w.toMs });
const K = Math.exp(-0.2);

/** An engine frame that records its calls; the test sets what is on screen (`show`). */
class FakeInner implements EngineFrame {
  readonly cameras: CameraState[] = [];
  readonly calls: string[] = [];
  /** Plan #68 C2b: the overlays and clicks sent, and the order of every record-writing call. */
  readonly overlays: OverlayState[] = [];
  readonly clicks: [number, number][] = [];
  readonly order: string[] = [];
  disposed = false;
  private st: StageModel | null = null;
  private readonly stageCbs = new Set<(s: StageModel | null) => void>();
  private readonly listeners = new Map<string, Set<(ev: never) => void>>();

  setSpec(): void {
    this.calls.push('setSpec');
  }
  setData(): void {
    this.calls.push('setData');
  }
  setTheme(): void {
    this.calls.push('setTheme');
  }
  setEvents(): void {
    this.calls.push('setEvents');
    this.order.push('setEvents');
  }
  setSelection(): void {
    this.calls.push('setSelection');
  }
  /** As `WasmFrame`: a zero size withdraws the stage at once. */
  resize(w: number, h: number): void {
    this.calls.push('resize');
    this.order.push('resize');
    if (!(w > 0 && h > 0)) this.show(null);
  }
  setCamera(c: CameraState): void {
    this.cameras.push(c);
    this.order.push('setCamera');
  }
  setOverlay(o: OverlayState): void {
    this.overlays.push(o);
    this.order.push('setOverlay');
  }
  select(x: number, y: number): void {
    this.clicks.push([x, y]);
    this.order.push('select');
  }
  stage(): StageModel | null {
    return this.st;
  }
  onStage(cb: (s: StageModel | null) => void): () => void {
    this.stageCbs.add(cb);
    return () => {
      this.stageCbs.delete(cb);
    };
  }
  on<E extends 'a11y' | 'drawn' | 'hover' | 'select'>(
    e: E,
    cb: (ev: FrameEvents[E]) => void,
  ): () => void {
    let set = this.listeners.get(e);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(e, set);
    }
    const fn = cb as (ev: never) => void;
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }
  dispose(): void {
    this.disposed = true;
  }
  /** An event of the engine frame (plan #68 C2b: `hover`, `select`). */
  fire<E extends 'hover' | 'select'>(e: E, ev: FrameEvents[E]): void {
    for (const cb of [...(this.listeners.get(e) ?? [])]) (cb as (x: FrameEvents[E]) => void)(ev);
  }
  show(s: StageModel | null): void {
    if (s === this.st) return;
    this.st = s;
    for (const cb of [...this.stageCbs]) cb(s);
  }
}

interface Setup {
  spec?: VisSpec;
  w?: TimeWindow;
  size?: readonly [number, number];
  stage?: StageModel | null;
  /** Plan #68 C2b: the canvas is its key target; the flush's scheduler (default: at once). */
  keys?: boolean;
  defer?: (cb: () => void) => void;
}

function setup(o: Setup = {}) {
  vi.useFakeTimers();
  const canvas = document.createElement('canvas');
  const inner = new FakeInner();
  const keyTarget = o.keys === true ? canvas : null;
  const f = new ControlledFrame(canvas, { timeZone: 'UTC', keyTarget, id: 'c1' }, inner, {
    wheelLatch: { lastPageWheel: () => -Infinity },
    defer:
      o.defer ??
      ((cb) => {
        cb();
      }),
  });
  const commits: CommitEvent[] = [];
  const brushes: BrushEvent[] = [];
  const selects: SelectEvent[] = [];
  const hovers: FrameEvents['hover'][] = [];
  f.on('hover', (h) => hovers.push(h));
  f.on('commit', (c) => commits.push(c));
  f.on('brush', (b) => brushes.push(b));
  f.on('select', (s) => selects.push(s));
  f.setSpec(o.spec ?? LINE);
  f.setData(lineData());
  f.setTimeWindow(o.w ?? W0);
  f.resize(o.size?.[0] ?? 1000, o.size?.[1] ?? 240, 1);
  if (o.stage !== null) inner.show(o.stage ?? S1);
  return { canvas, inner, f, commits, brushes, selects, hovers };
}

const lastCamera = (inner: FakeInner): CameraState | undefined => inner.cameras.at(-1);
const valueZoom = (base: ValueRange, f: number, k: number): ValueRange => {
  const anchor = base.min + f * (base.max - base.min);
  const next = zoomAbout({ lo: base.min, hi: base.max }, f, k, valueLimits(anchor));
  return { min: next.lo, max: next.hi };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('ControlledFrame (plan #68 C2a2)', () => {
  it('controlled: wheel, Shift+wheel, double click and right drag drive the engine camera', () => {
    const { canvas, inner, f, commits, brushes } = setup();
    expect(lastCamera(inner)).toEqual({ view: span(W0), value: null, band: null });
    const e = wheel(canvas, 320, 108, { deltaY: -100 });
    expect(e.defaultPrevented).toBe(true);
    const view = zoomAbout(span(W0), (320 - 50) / 900, K, timeLimits(900));
    expect(lastCamera(inner)).toEqual({ view, value: null, band: 38 });
    vi.advanceTimersByTime(300);
    expect(commits).toEqual([{ window: toWindow(view), value: null, gesture: 'wheel' }]);

    // An external window during a time gesture is no camera of its own.
    wheel(canvas, 320, 108, { deltaY: -100 });
    const n = inner.cameras.length;
    f.setTimeWindow({ fromMs: T0, toMs: T0 + 7_200_000 });
    expect(inner.cameras).toHaveLength(n);
    vi.advanceTimersByTime(300);
    expect(commits).toHaveLength(2);

    // Shift+wheel: the value view, committed without a window.
    const before = commits.length;
    wheel(canvas, 320, 108, { deltaY: -100, shiftKey: true });
    const value = valueZoom({ min: 0, max: 30 }, 0.5, K);
    expect(lastCamera(inner)?.value).toEqual(value);
    vi.advanceTimersByTime(300);
    expect(commits.slice(before)).toEqual([{ window: null, value, gesture: 'wheel' }]);

    // A right drag in the plot: one box brush.
    pointer(canvas, 'pointerdown', 320, 108, { button: 2, buttons: 2 });
    pointer(canvas, 'pointermove', 520, 108, { button: 2, buttons: 2 });
    pointer(canvas, 'pointerup', 520, 108, { button: 2 });
    expect(brushes).toHaveLength(1);
    expect(brushes[0]?.gesture).toBe('drag');

    // Disposed: nothing.
    f.dispose();
    expect(inner.disposed).toBe(true);
    const m = inner.cameras.length;
    const c = commits.length;
    expect(wheel(canvas, 320, 108, { deltaY: -100 }).defaultPrevented).toBe(false);
    vi.advanceTimersByTime(400);
    expect(inner.cameras).toHaveLength(m);
    expect(commits).toHaveLength(c);
  });

  it('controlled: a right drag brushes the dragged span of the window', () => {
    const { canvas, brushes } = setup();
    pointer(canvas, 'pointerdown', 320, 108, { button: 2, buttons: 2 });
    pointer(canvas, 'pointermove', 520, 108, { button: 2, buttons: 2 });
    pointer(canvas, 'pointerup', 520, 108, { button: 2 });
    const w = W0.toMs - W0.fromMs;
    const at = (px: number): number => W0.fromMs + ((px - 50) / 900) * w;
    const u = brushSnapUnit(w / 900);
    const snap = (t: number): number => Math.round(t / u) * u;
    expect(brushes).toEqual([{ fromMs: snap(at(320)), toMs: snap(at(520)), gesture: 'drag' }]);
  });

  it('controlled: no stage, no gesture', () => {
    const { canvas, inner, commits } = setup({ stage: null });
    const n = inner.cameras.length;
    expect(wheel(canvas, 320, 108, { deltaY: -100 }).defaultPrevented).toBe(false);
    vi.advanceTimersByTime(400);
    expect(inner.cameras).toHaveLength(n);
    expect(commits).toEqual([]);
    // The first presentation completes: the same wheel acts.
    inner.show(S1);
    expect(wheel(canvas, 320, 108, { deltaY: -100 }).defaultPrevented).toBe(true);
    expect(inner.cameras.length).toBeGreaterThan(n);
  });

  it('controlled: a double click on the value axis fits it', () => {
    const { canvas, commits } = setup({ spec: { ...LINE, valueRange: { min: 0, max: 10 } } });
    pointer(canvas, 'dblclick', 40, 58);
    expect(commits).toEqual([{ window: null, value: 'auto', gesture: 'fit' }]);
  });

  it('controlled C3: a sub-minimum preview survives a wider external window', () => {
    const T = T0;
    const plot = { x: 50, y: 8, width: 3_900, height: 200 };
    const { canvas, inner, f, commits } = setup({
      size: [4_000, 240],
      w: { fromMs: T, toMs: T + 2_000 },
      stage: { ...S1, plot },
    });
    expect(2_000).toBeLessThan(Math.ceil(plot.width));
    const p = { x: plot.x + 0.3 * plot.width, y: plot.y + plot.height / 2 };
    const ints = (v: Span | undefined): boolean =>
      v !== undefined && Number.isInteger(v.lo) && Number.isInteger(v.hi);
    wheel(canvas, p.x, p.y, { deltaX: 37 });
    const v1 = lastCamera(inner)?.view;
    expect(ints(v1)).toBe(true);
    expect((v1?.hi ?? 0) - (v1?.lo ?? 0)).toBe(2_000);
    f.setTimeWindow({ fromMs: T, toMs: T + 3_600_000 });
    wheel(canvas, p.x, p.y, { deltaX: 13 });
    const v2 = lastCamera(inner)?.view;
    if (v2 === undefined) throw new Error('no camera');
    expect(ints(v2)).toBe(true);
    expect(v2.hi - v2.lo).toBe(2_000);
    expect(v2).not.toEqual(v1);
    const ta = v2.lo + ((p.x - plot.x) / plot.width) * (v2.hi - v2.lo);
    for (let i = 0; i < 2; i++) {
      wheel(canvas, p.x, p.y, { deltaY: -400 });
      expect(lastCamera(inner)?.view).toEqual(v2);
    }
    vi.advanceTimersByTime(300);
    expect(commits).toEqual([
      { window: { fromMs: v2.lo, toMs: v2.hi }, value: null, gesture: 'wheel' },
    ]);
    const v = lastCamera(inner)?.view;
    if (v === undefined) throw new Error('no camera');
    const xOf = (t: number): number => plot.x + ((t - v.lo) / (v.hi - v.lo)) * plot.width;
    expect(Math.abs(xOf(ta) - p.x)).toBeLessThan(1e-6);
    f.setTimeWindow({ fromMs: v2.lo, toMs: v2.hi });
    expect(lastCamera(inner)?.view).toEqual(v2);
  });

  it('controlled abort: a withdrawn stage drops the gesture and restores the committed camera', () => {
    const { canvas, inner, commits, selects } = setup();
    const idle = { view: span(W0), value: null, band: null };
    // (a) A wheel, then the stage goes.
    wheel(canvas, 320, 108, { deltaY: -100 });
    expect(canvas.dataset['gesture']).toBeUndefined();
    inner.show(null);
    vi.advanceTimersByTime(300);
    expect(commits).toEqual([]);
    expect(lastCamera(inner)).toEqual(idle);
    expect(canvas.dataset['gesture']).toBeUndefined();
    // (b) A pan, then the stage goes, then the release.
    inner.show(S1);
    pointer(canvas, 'pointerdown', 320, 108, { buttons: 1 });
    pointer(canvas, 'pointermove', 420, 108, { buttons: 1 });
    expect(canvas.dataset['gesture']).toBe('pan');
    expect(lastCamera(inner)?.view).not.toEqual(span(W0));
    inner.show(null);
    expect(canvas.dataset['gesture']).toBeUndefined();
    pointer(canvas, 'pointerup', 420, 108);
    expect(commits).toEqual([]);
    expect(selects).toEqual([]);
    expect(lastCamera(inner)).toEqual(idle);
    // (c) Back: a wheel acts and commits once.
    inner.show(S1);
    wheel(canvas, 320, 108, { deltaY: -100 });
    const view = zoomAbout(span(W0), (320 - 50) / 900, K, timeLimits(900));
    expect(lastCamera(inner)).toEqual({ view, value: null, band: 38 });
    vi.advanceTimersByTime(300);
    expect(commits).toEqual([{ window: toWindow(view), value: null, gesture: 'wheel' }]);
  });

  it('controlled abort (d): a zero size withdraws the stage', () => {
    const { canvas, inner, f, commits } = setup();
    expect(wheel(canvas, 320, 108, { deltaY: -100 }).defaultPrevented).toBe(true);
    vi.advanceTimersByTime(300);
    expect(commits).toHaveLength(1);
    commits.length = 0;
    f.resize(0, 240, 1);
    const n = inner.cameras.length;
    expect(wheel(canvas, 320, 108, { deltaY: -100 }).defaultPrevented).toBe(false);
    vi.advanceTimersByTime(400);
    expect(inner.cameras).toHaveLength(n);
    expect(commits).toEqual([]);
  });

  it('controlled abort (e): the committed value and band, not the spec, are restored', () => {
    const { canvas, inner, commits } = setup();
    wheel(canvas, 320, 108, { deltaY: -100, shiftKey: true });
    vi.advanceTimersByTime(300);
    const value = valueZoom({ min: 0, max: 30 }, 0.5, K);
    expect(commits).toEqual([{ window: null, value, gesture: 'wheel' }]);
    wheel(canvas, 320, 108, { deltaY: -100, shiftKey: true });
    expect(lastCamera(inner)?.value).not.toEqual(value);
    inner.show(null);
    vi.advanceTimersByTime(400);
    expect(lastCamera(inner)).toEqual({ view: span(W0), value, band: 38 });
    expect(commits).toHaveLength(1);
  });

  it('controlled abort (f): a spec set mid-gesture is the committed value', () => {
    const { canvas, inner, f, commits } = setup();
    const P2 = { min: 5, max: 25 };
    wheel(canvas, 320, 108, { deltaY: -100 });
    f.setSpec({ ...LINE, valueRange: P2 });
    inner.show(null);
    vi.advanceTimersByTime(400);
    expect(lastCamera(inner)).toMatchObject({ view: span(W0), value: P2 });
    expect(commits).toEqual([]);
  });

  it('controlled stage: the controller acts on the stage on screen, not a pending layout', () => {
    const { canvas, inner, f, commits } = setup();
    // A new layout is submitted; the stage on screen is still S1.
    f.resize(1_200, 240, 1);
    expect(inner.stage()).toBe(S1);
    wheel(canvas, 320, 108, { deltaY: -100 });
    const view = zoomAbout(span(W0), (320 - 50) / 900, K, timeLimits(900));
    expect(lastCamera(inner)?.view).toEqual(view);
    // Withdrawn: wheel, drag and double click do nothing.
    inner.show(null);
    vi.advanceTimersByTime(400);
    expect(commits).toEqual([]);
    const n = inner.cameras.length;
    expect(wheel(canvas, 320, 108, { deltaY: -100 }).defaultPrevented).toBe(false);
    const down = pointer(canvas, 'pointerdown', 320, 108, { buttons: 1 });
    expect(down.defaultPrevented).toBe(false);
    pointer(canvas, 'pointermove', 420, 108, { buttons: 1 });
    pointer(canvas, 'pointerup', 420, 108);
    pointer(canvas, 'dblclick', 40, 58);
    vi.advanceTimersByTime(400);
    expect(inner.cameras).toHaveLength(n);
    expect(commits).toEqual([]);
    // Back: a wheel acts.
    inner.show(S1);
    expect(wheel(canvas, 320, 108, { deltaY: -100 }).defaultPrevented).toBe(true);
    expect(inner.cameras.length).toBeGreaterThan(n);
  });
});

describe('ControlledFrame hover, select and batching (plan #68 C2b §4.1)', () => {
  const S61: StageModel = { ...S1, pickCount: 61 };
  const H: NonNullable<FrameEvents['hover']> = {
    source: 'pointer',
    tMs: T0,
    xCss: 320,
    yCss: 108,
    rows: [{ key: '00000000000000a1', name: '{}', colourIndex: 1, value: 9 }],
  };

  it('controlled hover: the pointer, the key crosshair, a click and the box band reach the engine', () => {
    const { canvas, inner, f, hovers, selects } = setup({ stage: S61, keys: true });
    pointer(canvas, 'pointermove', 320, 108);
    expect(inner.overlays.at(-1)).toEqual({
      hover: { kind: 'pointer', x: 320, y: 108 },
      box: null,
    });
    key(canvas, 'ArrowRight');
    expect(inner.overlays.at(-1)).toEqual({ hover: { kind: 'key', index: 0 }, box: null });
    // The engine's hover is forwarded; a layout input clears it at once, then sends none.
    inner.fire('hover', H);
    expect(hovers).toEqual([H]);
    const n = inner.overlays.length;
    f.setData(lineData());
    expect(hovers).toEqual([H, null]);
    expect(inner.overlays.length).toBeGreaterThan(n);
    expect(inner.overlays.at(-1)).toEqual({ hover: { kind: 'none' }, box: null });
    // A null after a null is not re-emitted.
    inner.fire('hover', null);
    expect(hovers).toEqual([H, null]);
    // A click: the batched camera first, then the select; the engine's answer goes out.
    pointer(canvas, 'pointerdown', 320, 108, { button: 0, buttons: 1 });
    pointer(canvas, 'pointerup', 320, 108, { button: 0 });
    expect(inner.clicks).toEqual([[320, 108]]);
    expect(inner.order.lastIndexOf('setCamera')).toBeLessThan(inner.order.indexOf('select'));
    const item = { kind: 'point' as const, key: '00000000000000a1', tMs: T0, value: 9 };
    inner.fire('select', { source: 'pointer', item });
    expect(selects).toEqual([{ source: 'pointer', item }]);
    // A right drag shows the box band.
    pointer(canvas, 'pointerdown', 320, 108, { button: 2, buttons: 2 });
    pointer(canvas, 'pointermove', 420, 108, { button: 2, buttons: 2 });
    expect(inner.overlays.at(-1)?.box).toEqual({ x0: 320, x: 420 });
    pointer(canvas, 'pointerup', 420, 108, { button: 2 });
    expect(inner.overlays.at(-1)?.box).toBeNull();
  });

  it('controlled batch: one Camera and one Overlay per task, before any other call', () => {
    const queue: (() => void)[] = [];
    const run = (): void => {
      for (const cb of queue.splice(0)) cb();
    };
    const { canvas, inner, f } = setup({ defer: (cb) => queue.push(cb) });
    run();
    const c0 = inner.cameras.length;
    const o0 = inner.overlays.length;
    // A Ctrl+wheel zooms both axes: nothing before the flush, then one Camera and one Overlay.
    wheel(canvas, 320, 108, { deltaY: -100, ctrlKey: true });
    expect([inner.cameras.length, inner.overlays.length]).toEqual([c0, o0]);
    run();
    expect([inner.cameras.length, inner.overlays.length]).toEqual([c0 + 1, o0 + 1]);
    const cam = inner.cameras.at(-1);
    expect(cam?.view).not.toEqual(span(W0));
    expect(cam?.value).not.toBeNull();
    // A forwarding call flushes first: Camera, Overlay, then the call.
    inner.order.length = 0;
    f.resize(900, 240, 1);
    expect(inner.order).toEqual(['setCamera', 'setOverlay', 'resize']);
    run();
    expect(inner.order).toEqual(['setCamera', 'setOverlay', 'resize']);
    // Disposed with a flush queued: nothing more.
    pointer(canvas, 'pointermove', 330, 108);
    const n = inner.order.length;
    f.dispose();
    run();
    expect(inner.order.length).toBe(n);
  });
});

describe('ControlledFrame events (plan #68 C2c1 §4.1)', () => {
  const S61: StageModel = { ...S1, pickCount: 61 };
  const H: NonNullable<FrameEvents['hover']> = {
    source: 'pointer',
    tMs: T0,
    xCss: 320,
    yCss: 108,
    rows: [{ key: '00000000000000a1', name: '{}', colourIndex: 1, value: 9 }],
  };
  const ev = (id: string, atMs: number): EventMarker => ({
    id,
    atMs,
    endMs: null,
    kind: 'deploy',
    title: id,
  });

  it('controlled events: a band flip is a layout change (Canvas 2D rule); same array, no call', () => {
    const { canvas, inner, f, hovers } = setup({ stage: S61 });
    pointer(canvas, 'pointermove', 320, 108);
    inner.fire('hover', H);
    expect(hovers).toEqual([H]);
    // [] → [e]: the band appears: the hover is cleared at once, an Overlay of none is written,
    // then the events go.
    const e = [ev('e', T0 + 1_800_000)];
    inner.order.length = 0;
    f.setEvents(e);
    expect(hovers).toEqual([H, null]);
    expect(inner.overlays.at(-1)).toEqual({ hover: { kind: 'none' }, box: null });
    expect(inner.order).toEqual(['setCamera', 'setOverlay', 'setEvents']);
    // [e] → [e, f]: no band change: the events only, the hover untouched.
    pointer(canvas, 'pointermove', 330, 108);
    inner.fire('hover', H);
    expect(hovers).toEqual([H, null, H]);
    inner.order.length = 0;
    const ef = [...e, ev('f', T0 + 2_400_000)];
    f.setEvents(ef);
    expect(hovers).toEqual([H, null, H]);
    expect(inner.order).toEqual(['setEvents']);
    // The same array: no call.
    inner.order.length = 0;
    f.setEvents(ef);
    expect(inner.order).toEqual([]);
    // [e, f] → []: the band goes, a layout change again.
    f.setEvents([]);
    expect(hovers).toEqual([H, null, H, null]);
    expect(inner.order).toEqual(['setCamera', 'setOverlay', 'setEvents']);
  });
});
