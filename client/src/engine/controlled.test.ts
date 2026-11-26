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
  FrameEvents,
  SelectEvent,
  TimeWindow,
  ValueRange,
  VisSpec,
} from './api';
import { timeLimits, toWindow, valueLimits, zoomAbout, type Span } from './canvas2d/camera';
import { brushSnapUnit } from './canvas2d/columns';
import { ControlledFrame } from './controlled';
import type { CameraState, EngineFrame, StageModel } from './wasm/frame';
import { lineData, LINE, T0, W0 } from '../test/cameraKit';
import { pointer, wheel } from '../test/engineHarness';

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
  }
  setSelection(): void {
    this.calls.push('setSelection');
  }
  /** As `WasmFrame`: a zero size withdraws the stage at once. */
  resize(w: number, h: number): void {
    this.calls.push('resize');
    if (!(w > 0 && h > 0)) this.show(null);
  }
  setCamera(c: CameraState): void {
    this.cameras.push(c);
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
  on<E extends 'a11y' | 'drawn'>(e: E, cb: (ev: FrameEvents[E]) => void): () => void {
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
}

function setup(o: Setup = {}) {
  vi.useFakeTimers();
  const canvas = document.createElement('canvas');
  const inner = new FakeInner();
  const f = new ControlledFrame(canvas, { timeZone: 'UTC', keyTarget: null, id: 'c1' }, inner, {
    wheelLatch: { lastPageWheel: () => -Infinity },
  });
  const commits: CommitEvent[] = [];
  const brushes: BrushEvent[] = [];
  const selects: SelectEvent[] = [];
  f.on('commit', (c) => commits.push(c));
  f.on('brush', (b) => brushes.push(b));
  f.on('select', (s) => selects.push(s));
  f.setSpec(o.spec ?? LINE);
  f.setData(lineData());
  f.setTimeWindow(o.w ?? W0);
  f.resize(o.size?.[0] ?? 1000, o.size?.[1] ?? 240, 1);
  if (o.stage !== null) inner.show(o.stage ?? S1);
  return { canvas, inner, f, commits, brushes, selects };
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
