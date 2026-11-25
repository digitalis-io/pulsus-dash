/**
 * The interim Canvas 2D chart engine (ADR-0014 §3, §4; T01-003 interim exception, until #68). One
 * `Canvas2DFrame` per `<canvas>`, on the main thread. Inputs only store values and schedule one
 * frame; the frame redraws a cached layer when an input changed, then blits it and draws the
 * overlay (crosshair, hover dots, box band), and reports the completed draw (`drawn`, ADR-0019).
 *
 * The frame holds the interim 2D camera (#93, T02 §4.6, ADR-0020) as render-local state: a view
 * (time window and value range) previewed every frame from the resident data while a wheel, pinch,
 * swipe or drag is worked, and committed once at the gesture's end (`commit`: wheel idle 300 ms,
 * pointer up). The value-label band is held from the first camera move until a layout transition,
 * so the plot does not move under the pointer (T02-011 as amended, T02-021). Windows and ranges it
 * proposes go out as `brush` and `commit` events; the application changes the Context and the pin.
 *
 * Event markers (ADR-0023, `setEvents`) are drawn with the layer, through the drawn view, so they
 * follow the preview; their labels' boxes go out in the `a11y` summary (`eventLabels`).
 */
import type {
  ChartEngine,
  ChartFrame,
  CommitEvent,
  EventMarker,
  FrameData,
  FrameEvents,
  FrameInit,
  FrameSelection,
  HoverEvent,
  PlotRect,
  ThemeName,
  TimeWindow,
  ValueRange,
  VisSpec,
} from '../api';
import { fx, fy, panBy, timeLimits, toWindow, valueLimits, zoomAbout, type Span } from './camera';
import { brushSnapUnit } from './columns';
import type { Ctx2D } from './ctx';
import {
  AXIS_FONT,
  drawLayer,
  drawOverlay,
  forgetValueBands,
  minValueBand,
  MAX_SERIES,
  STAT_FONT,
  type LayerModel,
} from './draw';
import {
  DRAG_MIN_PX,
  PAGE_WHEEL_LATCH_MS,
  pressKind,
  WHEEL_IDLE_MS,
  wheelIntent,
  windowWheelLatch,
  zoneOf,
  type WheelLatch,
  type Zone,
} from './input';
import { bucketIndex, hoverRows, nearestIndex } from './pick';
import { themeColours } from './palette';

export { MAX_SERIES };

/** The browser gives no 2D context; the component shows `chart.unsupported`. */
export class ChartUnsupportedError extends Error {
  override readonly name = 'ChartUnsupportedError';
}

export interface Canvas2DOptions {
  /** Default `requestAnimationFrame`. */
  requestFrame?: (cb: () => void) => number;
  /** Default `cancelAnimationFrame`. */
  cancelFrame?: (id: number) => void;
  /** Default `c.getContext('2d')`. */
  contextOf?: (c: HTMLCanvasElement) => Ctx2D | null;
  /** The layer cache canvas; default `document.createElement('canvas')`. */
  createCanvas?: () => HTMLCanvasElement;
  /** Default `document.fonts`. */
  fonts?: Pick<FontFaceSet, 'load'> | null;
  /** Default `performance.now`. */
  now?: () => number;
  /** Default `setTimeout`. */
  setTimer?: (cb: () => void, ms: number) => number;
  /** Default `clearTimeout`. */
  clearTimer?: (id: number) => void;
  /** Default: one `windowWheelLatch(globalThis)` per page, created at the first `createFrame`. */
  wheelLatch?: WheelLatch;
}

interface Resolved {
  requestFrame: (cb: () => void) => number;
  cancelFrame: (id: number) => void;
  contextOf: (c: HTMLCanvasElement) => Ctx2D | null;
  createCanvas: () => HTMLCanvasElement;
  fonts: Pick<FontFaceSet, 'load'> | null;
  now: () => number;
  setTimer: (cb: () => void, ms: number) => number;
  clearTimer: (id: number) => void;
  wheelLatch: WheelLatch;
}

const MIN_BRUSH_MS = 1_000;

/** The page's wheel latch: one passive window listener, created with the first frame. */
let pageLatch: WheelLatch | null = null;
function defaultLatch(): WheelLatch {
  if (pageLatch === null) {
    const target = globalThis as unknown as Partial<Pick<Window, 'addEventListener'>>;
    pageLatch =
      typeof target.addEventListener === 'function'
        ? windowWheelLatch(target as Pick<Window, 'addEventListener'>)
        : { lastPageWheel: () => -Infinity };
  }
  return pageLatch;
}

export class Canvas2DEngine implements ChartEngine {
  private readonly o: Canvas2DOptions;

  constructor(o: Canvas2DOptions = {}) {
    this.o = o;
  }

  /** Throws `ChartUnsupportedError` when either canvas has no 2D context. */
  createFrame(canvas: HTMLCanvasElement, init: FrameInit): ChartFrame {
    const o = this.o;
    const r: Resolved = {
      requestFrame: o.requestFrame ?? ((cb) => requestAnimationFrame(cb)),
      cancelFrame:
        o.cancelFrame ??
        ((id) => {
          cancelAnimationFrame(id);
        }),
      contextOf: o.contextOf ?? ((c) => c.getContext('2d')),
      createCanvas: o.createCanvas ?? (() => document.createElement('canvas')),
      fonts:
        o.fonts === undefined
          ? ((globalThis.document as Document | undefined)?.fonts ?? null)
          : o.fonts,
      now: o.now ?? (() => performance.now()),
      setTimer: o.setTimer ?? ((cb, ms) => Number(setTimeout(cb, ms))),
      clearTimer:
        o.clearTimer ??
        ((id) => {
          clearTimeout(id);
        }),
      wheelLatch: o.wheelLatch ?? defaultLatch(),
    };
    return new Canvas2DFrame(canvas, init, r);
  }
}

type Listener = (ev: never) => void;
type Handler = readonly [string, (e: Event) => void, AddEventListenerOptions | undefined];

/** A DOM listener entry; `fn` receives the event type it is registered for. */
function listen(type: string, fn: (e: never) => unknown, opts?: AddEventListenerOptions): Handler {
  const f = fn as (e: Event) => unknown;
  return [
    type,
    (e) => {
      f(e);
    },
    opts,
  ];
}

/** The axes a gesture moved; set by its preview steps, never reset during the gesture. */
interface Changed {
  x: boolean;
  y: boolean;
}

/** A wheel, swipe or pinch gesture; `scale` is the last Safari gesture scale while one runs. */
interface WheelGesture {
  readonly kind: 'wheel';
  timer: number;
  x: number;
  y: number;
  readonly changed: Changed;
  scale: number | null;
}

/** A handled press: time pan, value pan or box zoom. */
interface PressGesture {
  readonly kind: 'press';
  readonly press: 'pan' | 'pan-y' | 'box';
  readonly zone: Zone;
  readonly pointerId: number;
  readonly x0: number;
  readonly y0: number;
  x: number;
  y: number;
  moved: boolean;
  readonly view0: Span;
  readonly value0: ValueRange | null;
  readonly domain0: ValueRange | null;
  readonly changed: Changed;
}

type Gesture = WheelGesture | PressGesture;

const spanOf = (w: TimeWindow): Span => ({ lo: w.fromMs, hi: w.toMs });

/** A spec's value-axis pin when it is one the engine draws (line, bars; finite, min < max). */
function rangeOf(spec: VisSpec | null): ValueRange | null {
  if (spec === null || (spec.kind !== 'line' && spec.kind !== 'bars')) return null;
  const r = spec.valueRange;
  if (r === undefined || !Number.isFinite(r.min) || !Number.isFinite(r.max) || !(r.min < r.max))
    return null;
  return r;
}

const sameRange = (a: ValueRange | null, b: ValueRange | null): boolean =>
  a === b || (a !== null && b !== null && a.min === b.min && a.max === b.max);

class Canvas2DFrame implements ChartFrame {
  private readonly ctx: Ctx2D;
  private readonly layer: HTMLCanvasElement;
  private readonly layerCtx: Ctx2D;
  private spec: VisSpec | null = null;
  private data: FrameData | null = null;
  /** The last `setEvents` (ADR-0023); [] = none. */
  private events: readonly EventMarker[] = [];
  /** The base window: the last `setTimeWindow`, or the last committed view. */
  private window: TimeWindow | null = null;
  /** What is drawn, f64: `window` when idle, the gesture's preview otherwise. */
  private view: Span | null = null;
  /** The drawn value range: the spec's pin when idle, the preview otherwise; null = auto. */
  private valueView: ValueRange | null = null;
  private gesture: Gesture | null = null;
  /** The held value-label band width (§4.2a); null = free. */
  private bandHold: number | null = null;
  /** A right press in the plot awaits its `contextmenu`. */
  private rightPress = false;
  private rightTimer: number | null = null;
  private zone: Zone = null;
  private theme: ThemeName = 'dark';
  private cssW = 0;
  private cssH = 0;
  private dpr = 1;
  private layerDirty = false;
  private hoverDirty = false;
  private scheduled: number | null = null;
  private disposed = false;
  private model: LayerModel | null = null;
  private summaryKey = '';
  private pointer: { x: number; y: number } | null = null;
  private keyIndex: number | null = null;
  private lastHover: HoverEvent | null = null;
  private listening = false;
  private readonly listeners = new Map<keyof FrameEvents, Set<Listener>>();
  private readonly canvasHandlers: readonly Handler[];
  private readonly keyHandlers: readonly Handler[];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly init: FrameInit,
    private readonly r: Resolved,
  ) {
    const ctx = r.contextOf(canvas);
    if (ctx === null) throw new ChartUnsupportedError('no 2D context');
    this.ctx = ctx;
    this.layer = r.createCanvas();
    const layerCtx = r.contextOf(this.layer);
    if (layerCtx === null) throw new ChartUnsupportedError('no 2D context for the layer');
    this.layerCtx = layerCtx;
    const active = { passive: false };
    this.canvasHandlers = [
      listen('pointerdown', this.onPointerDown.bind(this)),
      listen('pointermove', this.onPointerMove.bind(this)),
      listen('pointerup', this.onPointerUp.bind(this)),
      listen('pointercancel', this.cancelPress.bind(this)),
      listen('lostpointercapture', this.cancelPress.bind(this)),
      listen('pointerleave', this.onPointerLeave.bind(this)),
      listen('dblclick', this.onDoubleClick.bind(this)),
      listen('contextmenu', this.onContextMenu.bind(this)),
      listen('wheel', this.onWheel.bind(this), active),
      listen('gesturestart', this.onGestureStart.bind(this), active),
      listen('gesturechange', this.onGestureChange.bind(this), active),
      listen('gestureend', this.onGestureEnd.bind(this), active),
    ];
    this.keyHandlers = [
      listen('keydown', this.onKeyDown.bind(this)),
      listen('focusout', this.onFocusOut.bind(this)),
    ];
    for (const f of [AXIS_FONT, STAT_FONT]) {
      const loaded = (): void => {
        forgetValueBands(this.layerCtx);
        this.invalidate();
      };
      r.fonts?.load(f).then(loaded, loaded);
    }
  }

  setSpec(spec: VisSpec): void {
    if (this.disposed) return;
    const prev = this.spec;
    if (prev !== null && spec.kind !== prev.kind) {
      // A kept canvas never shows the previous kind; the redraw follows in the next frame (#90).
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
    const next = rangeOf(spec);
    const relayout =
      prev !== null &&
      (prev.kind !== spec.kind || JSON.stringify(prev.unit) !== JSON.stringify(spec.unit));
    // A kind or unit change, or a pin cleared (Reset Y axis, the fit commit), releases the band.
    if (relayout || (rangeOf(prev) !== null && next === null)) this.bandHold = null;
    this.spec = spec;
    if (this.gesture?.changed.y !== true) this.valueView = next;
    this.syncListeners();
    this.changed();
  }

  setData(data: FrameData): void {
    if (this.disposed) return;
    this.data = data;
    this.changed();
  }

  setTimeWindow(w: TimeWindow): void {
    if (this.disposed) return;
    const win = { fromMs: w.fromMs, toMs: w.toMs };
    const g = this.gesture;
    if (g?.changed.x === true) {
      // The user's move wins at the commit, which compares the preview with this new base.
      this.window = win;
      return;
    }
    const base = this.window;
    if (g === null && (base === null || base.fromMs !== win.fromMs || base.toMs !== win.toMs)) {
      this.bandHold = null;
    }
    this.window = win;
    this.view = spanOf(win);
    this.changed();
  }

  /**
   * The event markers (ADR-0023), drawn in the layer through the view's time transform, so they
   * follow a gesture's preview. Gaining or losing every event moves the plot (the label band): the
   * hover is cleared then, as for any layout input; other changes only redraw the layer.
   */
  setEvents(events: readonly EventMarker[]): void {
    if (this.disposed || events === this.events) return;
    const band = this.events.length > 0 !== events.length > 0;
    this.events = events;
    if (band) this.changed();
    else this.invalidate();
  }

  setSelection(sel: FrameSelection | null): void {
    void sel;
  }

  setTheme(t: ThemeName): void {
    if (this.disposed) return;
    this.theme = t;
    this.changed();
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    if (this.disposed) return;
    if (cssWidth !== this.cssW || cssHeight !== this.cssH) this.bandHold = null;
    this.cssW = cssWidth;
    this.cssH = cssHeight;
    this.dpr = dpr;
    const w = Math.max(0, Math.round(cssWidth * dpr));
    const h = Math.max(0, Math.round(cssHeight * dpr));
    for (const c of [this.canvas, this.layer]) {
      c.width = w;
      c.height = h;
    }
    this.changed();
  }

  on<E extends keyof FrameEvents>(e: E, cb: (ev: FrameEvents[E]) => void): () => void {
    if (this.disposed) return () => undefined;
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
    if (this.disposed) return;
    this.disposed = true;
    if (this.scheduled !== null) this.r.cancelFrame(this.scheduled);
    this.scheduled = null;
    // No commit after dispose: the gesture and its timers are dropped.
    if (this.gesture?.kind === 'wheel') this.r.clearTimer(this.gesture.timer);
    this.gesture = null;
    this.clearRightPress();
    this.setListening(false);
    this.listeners.clear();
    for (const c of [this.canvas, this.layer]) {
      c.width = 0;
      c.height = 0;
    }
    this.model = null;
  }

  // Inputs.

  private emit<E extends keyof FrameEvents>(e: E, ev: FrameEvents[E]): void {
    for (const cb of [...(this.listeners.get(e) ?? [])]) (cb as (x: FrameEvents[E]) => void)(ev);
  }

  /** A stored input changed: redraw the layer and clear the hover. */
  private changed(): void {
    this.layerDirty = true;
    this.pointer = null;
    this.keyIndex = null;
    if (this.lastHover !== null) {
      this.lastHover = null;
      this.emit('hover', null);
    }
    this.schedule();
  }

  private invalidate(): void {
    if (this.disposed) return;
    this.layerDirty = true;
    this.schedule();
  }

  private schedule(): void {
    if (this.scheduled !== null || this.disposed) return;
    this.scheduled = this.r.requestFrame(() => {
      this.scheduled = null;
      this.frame();
    });
  }

  private syncListeners(): void {
    this.setListening(this.spec !== null && this.spec.kind !== 'stat');
  }

  private setListening(on: boolean): void {
    if (on === this.listening) return;
    this.listening = on;
    for (const [type, fn, opts] of this.canvasHandlers) {
      if (on) this.canvas.addEventListener(type, fn, opts);
      else this.canvas.removeEventListener(type, fn);
    }
    const target = this.init.keyTarget;
    if (target === null) return;
    for (const [type, fn] of this.keyHandlers) {
      if (on) target.addEventListener(type, fn);
      else target.removeEventListener(type, fn);
    }
  }

  // Frame.

  private frame(): void {
    if (this.disposed) return;
    if (!(this.cssW > 0) || !(this.cssH > 0)) {
      this.layerDirty = false;
      return;
    }
    if (this.layerDirty) {
      this.layerDirty = false;
      const start = this.r.now();
      this.model = this.drawLayer();
      const end = this.r.now();
      if (this.model !== null) {
        try {
          performance.measure('chart-draw', {
            start,
            end,
            detail: {
              kind: this.model.summary.kind,
              series: this.model.summary.seriesShown,
              frame: this.init.id ?? null,
            },
          });
          performance.clearMeasures('chart-draw');
        } catch {
          // The User Timing API is optional: drawing does not depend on it.
        }
        const key = JSON.stringify(this.model.summary);
        if (key !== this.summaryKey) {
          this.summaryKey = key;
          this.emit('a11y', this.model.summary);
        }
      }
    }
    let hover = this.lastHover;
    if (this.hoverDirty) {
      this.hoverDirty = false;
      hover = this.currentHover();
      if (hover !== null || this.lastHover !== null) {
        this.lastHover = hover;
        this.emit('hover', hover);
      }
    }
    this.drawVisible(hover);
    // The visible canvas is complete at this size (ADR-0019); never at a zero size or disposed.
    this.emit('drawn', { cssWidth: this.cssW, cssHeight: this.cssH, dpr: this.dpr });
  }

  private drawLayer(): LayerModel | null {
    const ctx = this.layerCtx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const colours = themeColours(this.theme);
    const v = this.view;
    if (this.spec === null || this.data === null || v === null) {
      ctx.fillStyle = colours.background;
      ctx.fillRect(0, 0, this.cssW, this.cssH);
      return null;
    }
    const valueAxis = this.spec.kind === 'line' || this.spec.kind === 'bars';
    return drawLayer({
      ctx,
      spec: this.spec,
      data: this.data,
      window: { fromMs: v.lo, toMs: v.hi },
      cssW: this.cssW,
      cssH: this.cssH,
      timeZone: this.init.timeZone,
      colours,
      valueRange: valueAxis ? this.valueView : null,
      band: this.spec.kind === 'stat' ? null : this.bandHold,
      // T02-011: the band is at least the widest compact label of the unit.
      minBand: this.spec.kind === 'stat' ? 0 : minValueBand(ctx, this.spec.unit),
      events: this.events,
    });
  }

  private drawVisible(hover: HoverEvent | null): void {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.drawImage(this.layer, 0, 0, this.cssW, this.cssH);
    const g = this.gesture;
    const box = g?.kind === 'press' && g.press === 'box' && g.moved ? { x0: g.x0, x: g.x } : null;
    if (this.model !== null) drawOverlay(ctx, this.model, themeColours(this.theme), hover, box);
  }

  private currentHover(): HoverEvent | null {
    const m = this.model;
    const v = this.view;
    if (m === null || m.pick === null || v === null) return null;
    const { plot } = m.summary;
    const xOf = (t: number): number => plot.x + ((t - v.lo) / (v.hi - v.lo)) * plot.width;
    if (this.keyIndex !== null) {
      const { tMs, rows } = hoverRows(m.pick, this.keyIndex, 'keyboard', plot.y);
      return { source: 'keyboard', tMs, xCss: xOf(tMs), yCss: plot.y, rows };
    }
    const p = this.pointer;
    if (p === null) return null;
    const t = v.lo + ((p.x - plot.x) / plot.width) * (v.hi - v.lo);
    const i = m.pick.kind === 'line' ? nearestIndex(m.pick.ref, t) : bucketIndex(m.pick.ref, t);
    if (i < 0) return null;
    const { tMs, rows } = hoverRows(m.pick, i, 'pointer', p.y);
    return { source: 'pointer', tMs, xCss: xOf(tMs), yCss: p.y, rows };
  }

  // Camera (#93, plan §4.2).

  /** The plot and kind when the camera can act (a drawn, non-empty plot and a window). */
  private stage(): { plot: PlotRect; spec: VisSpec; model: LayerModel; view: Span } | null {
    const model = this.model;
    const spec = this.spec;
    const view = this.view;
    if (model === null || spec === null || view === null) return null;
    const plot = model.summary.plot;
    if (!(plot.width > 0) || !(plot.height > 0)) return null;
    return { plot, spec, model, view };
  }

  private zoneAt(p: { x: number; y: number }): Zone {
    const s = this.stage();
    return s === null ? null : zoneOf(p, s.plot, s.spec.kind);
  }

  /** A preview step moved the view: hold the band of the frame on screen and redraw. */
  private previewed(): void {
    this.bandHold ??= this.model?.labelW ?? null;
    this.layerDirty = true;
    this.hoverDirty = true;
    this.schedule();
  }

  /** Time pans of a view narrower than the minimum span move whole ms (F1: the preview's span). */
  private timeStep(v: Span, plot: PlotRect): number {
    return v.hi - v.lo < timeLimits(plot.width).minSpan ? 1 : 0;
  }

  private setView(next: Span, changed: Changed): void {
    if (next === this.view) return;
    this.view = next;
    changed.x = true;
    this.previewed();
  }

  private setValueView(next: Span, changed: Changed): void {
    const cur = this.valueView;
    if (cur !== null && next.lo === cur.min && next.hi === cur.max) return;
    this.valueView = { min: next.lo, max: next.hi };
    changed.y = true;
    this.previewed();
  }

  /** Zooms time (`x`) and values (`y`) about `p`; values only on line and bars. */
  private zoomAt(changed: Changed, p: { x: number; y: number }, x: boolean, y: boolean, k: number) {
    const s = this.stage();
    if (s === null) return;
    if (x) this.setView(zoomAbout(s.view, fx(s.plot, p.x), k, timeLimits(s.plot.width)), changed);
    const base = this.valueView ?? s.model.valueDomain;
    if (y && base !== null && (s.spec.kind === 'line' || s.spec.kind === 'bars')) {
      const f = fy(s.plot, p.y);
      const anchor = base.min + f * (base.max - base.min);
      const next = zoomAbout({ lo: base.min, hi: base.max }, f, k, valueLimits(anchor));
      this.setValueView(next, changed);
    }
  }

  /** Starts a wheel gesture or continues it: the anchor moves to `p`; the idle timer is re-armed. */
  private wheelGesture(p: { x: number; y: number }): WheelGesture {
    let g = this.gesture;
    if (g?.kind !== 'wheel') {
      g = {
        kind: 'wheel',
        timer: -1,
        x: p.x,
        y: p.y,
        changed: { x: false, y: false },
        scale: null,
      };
      this.gesture = g;
      this.keyIndex = null;
    }
    g.x = p.x;
    g.y = p.y;
    this.r.clearTimer(g.timer);
    g.timer = this.r.setTimer(() => {
      this.endWheel();
    }, WHEEL_IDLE_MS);
    // The pointer stays: hover follows it on every preview frame.
    this.pointer = this.zoneAt(p) === 'plot' ? p : null;
    this.hoverDirty = true;
    this.schedule();
    return g;
  }

  private endWheel(): void {
    const g = this.gesture;
    if (g?.kind !== 'wheel' || this.disposed) return;
    this.r.clearTimer(g.timer);
    this.gesture = null;
    this.commit(g.changed, 'wheel');
  }

  /**
   * The commit rules (§4.2a): only the axes the gesture moved, only when they differ from the
   * base window and the spec's pin. The frame then adopts the whole-ms view as its base.
   */
  private commit(changed: Changed, gesture: CommitEvent['gesture']): void {
    delete this.canvas.dataset['gesture'];
    let window: TimeWindow | null = null;
    const v = this.view;
    if (changed.x && v !== null) {
      const w = toWindow(v);
      const base = this.window;
      if (base === null || base.fromMs !== w.fromMs || base.toMs !== w.toMs) window = w;
      this.window = w;
      this.view = spanOf(w);
    }
    const vv = this.valueView;
    const value = changed.y && vv !== null && !sameRange(vv, rangeOf(this.spec)) ? vv : null;
    // The same view and held band: a redraw with whole-ms ends, no layout change.
    this.layerDirty = true;
    this.schedule();
    if (window !== null || value !== null) this.emit('commit', { window, value, gesture });
  }

  private onWheel(e: WheelEvent): void {
    const g = this.gesture;
    if (g?.kind === 'press') {
      // A wheel during a press is consumed and ignored.
      e.preventDefault();
      return;
    }
    const s = this.stage();
    if (s === null) return;
    const p = this.local(e);
    if (zoneOf(p, s.plot, s.spec.kind) !== 'plot') return;
    // A page scroll already in progress keeps scrolling over a plot (§4.4, A.10), also while this
    // chart's own wheel gesture is pending (code review r1).
    if (e.timeStamp - this.r.wheelLatch.lastPageWheel() < PAGE_WHEEL_LATCH_MS) return;
    if (g !== null && g.scale !== null && e.ctrlKey) {
      // Safari sends `ctrl` wheels alongside its gesture events: the gesture drives the zoom.
      e.preventDefault();
      return;
    }
    const intent = wheelIntent(e, s.plot);
    if (intent === null) return;
    e.preventDefault();
    const w = this.wheelGesture(p);
    if (intent.kind === 'zoom') {
      this.zoomAt(w.changed, p, intent.x, intent.y, intent.factor);
      return;
    }
    const L = timeLimits(s.plot.width);
    this.setView(panBy(s.view, intent.fraction, L, this.timeStep(s.view, s.plot)), w.changed);
  }

  private onGestureStart(e: Event): void {
    if (this.gesture?.kind === 'press') return;
    const p = this.local(e as unknown as MouseEvent);
    if (this.zoneAt(p) !== 'plot') return;
    e.preventDefault();
    this.wheelGesture(p).scale = gestureScale(e);
  }

  private onGestureChange(e: Event): void {
    const g = this.gesture;
    if (g?.kind !== 'wheel' || g.scale === null) return;
    e.preventDefault();
    const scale = gestureScale(e);
    const factor = g.scale / scale;
    const p = this.local(e as unknown as MouseEvent);
    this.wheelGesture(p).scale = scale;
    if (Number.isFinite(factor) && factor > 0) this.zoomAt(g.changed, p, true, false, factor);
  }

  private onGestureEnd(e: Event): void {
    const g = this.gesture;
    if (g?.kind !== 'wheel' || g.scale === null) return;
    e.preventDefault();
    g.scale = null;
  }

  // Pointer and keys.

  private local(e: MouseEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private hoverChanged(): void {
    this.hoverDirty = true;
    this.schedule();
  }

  private setZone(z: Zone): void {
    this.zone = z;
    if (z === null) delete this.canvas.dataset['zone'];
    else this.canvas.dataset['zone'] = z;
  }

  private onPointerMove(e: PointerEvent): void {
    const p = this.local(e);
    const g = this.gesture;
    if (g?.kind === 'press') {
      if (e.pointerId === g.pointerId) this.pressMove(g, p);
      return;
    }
    const zone = this.zoneAt(p);
    if (zone !== this.zone) this.setZone(zone);
    this.keyIndex = null;
    this.pointer = zone === 'plot' ? p : null;
    this.hoverChanged();
  }

  private pressMove(g: PressGesture, p: { x: number; y: number }): void {
    g.x = p.x;
    g.y = p.y;
    if (!g.moved) {
      const d = g.press === 'pan-y' ? Math.abs(p.y - g.y0) : Math.abs(p.x - g.x0);
      if (d < DRAG_MIN_PX) return;
      g.moved = true;
    }
    const s = this.stage();
    if (s === null) return;
    switch (g.press) {
      case 'box':
        this.schedule();
        return;
      case 'pan': {
        // The content follows the pointer.
        const L = timeLimits(s.plot.width);
        const step = this.timeStep(g.view0, s.plot);
        this.setView(panBy(g.view0, -(p.x - g.x0) / s.plot.width, L, step), g.changed);
        return;
      }
      case 'pan-y': {
        const base = g.value0 ?? g.domain0;
        if (base === null) return;
        const mid = (base.min + base.max) / 2;
        const next = panBy(
          { lo: base.min, hi: base.max },
          (p.y - g.y0) / s.plot.height,
          valueLimits(mid),
        );
        this.setValueView(next, g.changed);
        return;
      }
    }
  }

  private onPointerLeave(): void {
    this.pointer = null;
    this.setZone(null);
    if (this.gesture === null && this.bandHold !== null) {
      // The pointer left the chart: the band re-measures and full labels return.
      this.bandHold = null;
      this.layerDirty = true;
    }
    this.hoverChanged();
  }

  private onPointerDown(e: PointerEvent): void {
    this.clearRightPress();
    const s = this.stage();
    if (s === null) return;
    const p = this.local(e);
    const zone = zoneOf(p, s.plot, s.spec.kind);
    if (e.button === 2 && zone === 'plot') this.rightPress = true;
    const press = pressKind(e, zone);
    if (press === null || this.gesture?.kind === 'press') return;
    if (press === 'pan-y' && s.model.valueDomain === null) return;
    // A pending wheel move commits before the press starts.
    if (this.gesture?.kind === 'wheel') this.endWheel();
    e.preventDefault();
    // Not every environment implements pointer capture (jsdom does not).
    const target: { setPointerCapture?: (id: number) => void } = this.canvas;
    try {
      target.setPointerCapture?.(e.pointerId);
    } catch {
      // Capture is best effort: a drag that leaves the canvas still ends on pointerup or cancel.
    }
    this.gesture = {
      kind: 'press',
      press,
      zone,
      pointerId: e.pointerId,
      x0: p.x,
      y0: p.y,
      x: p.x,
      y: p.y,
      moved: false,
      view0: this.view ?? s.view,
      value0: this.valueView,
      domain0: s.model.valueDomain,
      changed: { x: false, y: false },
    };
    this.canvas.dataset['gesture'] =
      press === 'box' ? 'box' : press === 'pan-y' ? 'axis-y' : zone === 'x-axis' ? 'axis-x' : 'pan';
    this.keyIndex = null;
    this.pointer = null;
    this.hoverChanged();
  }

  private onPointerUp(e: PointerEvent): void {
    if (this.rightPress) this.armRightClear();
    const g = this.gesture;
    if (g?.kind !== 'press' || e.pointerId !== g.pointerId) return;
    this.gesture = null;
    delete this.canvas.dataset['gesture'];
    this.schedule();
    if (!g.moved) return;
    if (g.press === 'box') {
      this.box(g.x0, this.local(e).x);
      return;
    }
    this.commit(g.changed, g.zone === 'plot' ? 'pan' : 'axis');
  }

  /** The box zoom: the dragged span, snapped as the brush always was (≥ 1 s). */
  private box(x0: number, x: number): void {
    const plot = this.model?.summary.plot;
    const w = this.window;
    if (plot === undefined || w === null || Math.abs(x - x0) < DRAG_MIN_PX) return;
    const span = w.toMs - w.fromMs;
    const at = (px: number): number =>
      Math.min(w.toMs, Math.max(w.fromMs, w.fromMs + ((px - plot.x) / plot.width) * span));
    const u = brushSnapUnit(span / plot.width);
    const snap = (t: number): number => Math.round(t / u) * u;
    const fromMs = snap(Math.min(at(x0), at(x)));
    const toMs = snap(Math.max(at(x0), at(x)));
    if (toMs - fromMs >= MIN_BRUSH_MS) this.emit('brush', { fromMs, toMs, gesture: 'drag' });
  }

  /** Escape, `pointercancel`, `lostpointercapture`: the press ends; view, value and band restored. */
  private cancelPress(): boolean {
    const g = this.gesture;
    if (g?.kind !== 'press') return false;
    this.gesture = null;
    delete this.canvas.dataset['gesture'];
    if (g.moved) {
      this.view = this.window === null ? null : spanOf(this.window);
      this.valueView = g.value0;
      // The camera move is undone: the band re-measures and full labels return.
      this.bandHold = null;
      this.layerDirty = true;
    }
    this.schedule();
    return true;
  }

  private onContextMenu(e: Event): void {
    if (!this.rightPress) return;
    // No browser menu for a right drag or right click on the plot (amended acceptance 4).
    e.preventDefault();
    this.clearRightPress();
  }

  /** `rightPress` lasts until a 0 ms timer after its `pointerup` (the Windows event order). */
  private armRightClear(): void {
    if (this.rightTimer !== null) this.r.clearTimer(this.rightTimer);
    this.rightTimer = this.r.setTimer(() => {
      this.rightTimer = null;
      this.rightPress = false;
    }, 0);
  }

  private clearRightPress(): void {
    this.rightPress = false;
    if (this.rightTimer !== null) this.r.clearTimer(this.rightTimer);
    this.rightTimer = null;
  }

  private onDoubleClick(e: MouseEvent): void {
    const w = this.window;
    const zone = this.zoneAt(this.local(e));
    if (w === null) return;
    if (zone === 'plot') {
      const width = w.toMs - w.fromMs;
      const fromMs = w.fromMs - Math.floor(width / 2);
      this.emit('brush', { fromMs, toMs: fromMs + 2 * width, gesture: 'zoomOut' });
      return;
    }
    if (zone !== 'y-axis' || (this.valueView === null && rangeOf(this.spec) === null)) return;
    // The value axis back to auto (INT-008).
    this.valueView = null;
    this.layerDirty = true;
    this.schedule();
    this.emit('commit', { window: null, value: 'auto', gesture: 'fit' });
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const n = this.model?.pick?.ref.length ?? 0;
    const i = this.keyIndex;
    let next: number | null | undefined;
    switch (e.key) {
      case 'ArrowRight':
        next = i === null ? 0 : i + 1;
        break;
      case 'ArrowLeft':
        next = i === null ? n - 1 : i - 1;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = n - 1;
        break;
      case 'PageUp':
        next = i === null ? undefined : i + 10;
        break;
      case 'PageDown':
        next = i === null ? undefined : i - 10;
        break;
      case 'Escape': {
        const pressing = this.cancelPress();
        if (i === null && !pressing) return;
        e.preventDefault();
        if (i !== null) {
          this.keyIndex = null;
          this.hoverChanged();
        }
        return;
      }
      default:
        return;
    }
    if (next === undefined || n === 0) return;
    e.preventDefault();
    this.keyIndex = Math.min(n - 1, Math.max(0, next));
    this.pointer = null;
    this.hoverChanged();
  }

  private onFocusOut(): void {
    if (this.keyIndex === null) return;
    this.keyIndex = null;
    this.hoverChanged();
  }
}

/** Safari's `GestureEvent.scale` (not in the DOM types); 1 when absent. */
function gestureScale(e: Event): number {
  const s = (e as Event & { scale?: unknown }).scale;
  return typeof s === 'number' && s > 0 ? s : 1;
}
