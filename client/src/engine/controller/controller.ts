/**
 * The interim 2D camera controller (#93, T02 §4.6, ADR-0020), shared by both engines (plan #68
 * C2a2 §3.1, Part A §4.9 C1; ADR-0030): the Canvas 2D frame and `ControlledFrame` (engine frames)
 * drive one `FrameController` each, on the main thread where the DOM listeners are. Moved
 * unchanged from `Canvas2DFrame`: the base window, the drawn view and value view, the wheel and
 * press gestures, the held value-label band (T02-011 as amended, T02-021) and the commit rules.
 * It reads the geometry of the frame on screen through its `Stage` and tells the frame what
 * changed; windows and ranges it proposes go out as `brush` and `commit` events.
 *
 * Additions for engine frames (Canvas 2D never calls them): `committed`, the camera of the last
 * external input or emitted commit, and `abortGesture()`, which drops a gesture when the stage is
 * withdrawn and restores `committed`, emitting nothing.
 *
 * A bar chart (ADR-0028, ADR-0029) has no camera: its pointer events and its key target's keydown,
 * `focus` and `focusout` go to the `BarHooks`, and its wheel, gestures, double click and context
 * menu are ignored.
 */
import type { CommitEvent, FrameInit, PlotRect, TimeWindow, ValueRange, VisSpec } from '../api';
import {
  fx,
  fy,
  panBy,
  timeLimits,
  toWindow,
  valueLimits,
  zoomAbout,
  type Span,
} from '../canvas2d/camera';
import { brushSnapUnit } from '../canvas2d/columns';
import {
  gestureScale,
  listen,
  rangeOf,
  sameRange,
  spanOf,
  type Changed,
  type Gesture,
  type Handler,
  type PressGesture,
  type WheelGesture,
} from '../canvas2d/gesture';
import {
  DRAG_MIN_PX,
  PAGE_WHEEL_LATCH_MS,
  pressKind,
  WHEEL_IDLE_MS,
  wheelIntent,
  zoneOf,
  type Zone,
} from '../canvas2d/input';
import type { BarHooks, ControllerDeps, Point, Stage, StageModel } from './stage';

const MIN_BRUSH_MS = 1_000;

/** The camera an engine frame's withdrawn gesture returns to (plan #68 C2a2 §3.1). */
interface Committed {
  window: TimeWindow | null;
  valueView: ValueRange | null;
  band: number | null;
}

export class FrameController {
  private spec: VisSpec | null = null;
  /** The base window: the last `setTimeWindow`, or the last committed view. */
  private window: TimeWindow | null = null;
  /** What is drawn, f64: `window` when idle, the gesture's preview otherwise. */
  private viewSpan: Span | null = null;
  /** The drawn value range: the spec's pin when idle, the preview otherwise; null = auto. */
  private valueRange: ValueRange | null = null;
  private gesture: Gesture | null = null;
  /** The held value-label band width (§4.2a); null = free. */
  private held: number | null = null;
  /** A right press in the plot awaits its `contextmenu`. */
  private rightPress = false;
  private rightTimer: number | null = null;
  private zone: Zone = null;
  private cssW = 0;
  private cssH = 0;
  private pointerAt: Point | null = null;
  private keyAt: number | null = null;
  private listening = false;
  private disposed = false;
  private committed: Committed = { window: null, valueView: null, band: null };
  private readonly canvasHandlers: readonly Handler[];
  private readonly keyHandlers: readonly Handler[];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly init: FrameInit,
    private readonly host: Stage,
    private readonly deps: ControllerDeps,
    private readonly bar: BarHooks | null,
  ) {
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
      listen('focus', this.onFocus.bind(this)),
      listen('focusout', this.onFocusOut.bind(this)),
    ];
  }

  get view(): Span | null {
    return this.viewSpan;
  }

  get valueView(): ValueRange | null {
    return this.valueRange;
  }

  get bandHold(): number | null {
    return this.held;
  }

  get pointer(): Point | null {
    return this.pointerAt;
  }

  get keyIndex(): number | null {
    return this.keyAt;
  }

  /** The box zoom's band while a moved box press runs. */
  box(): { x0: number; x: number } | null {
    const g = this.gesture;
    return g?.kind === 'press' && g.press === 'box' && g.moved ? { x0: g.x0, x: g.x } : null;
  }

  setSpec(spec: VisSpec): void {
    if (this.disposed) return;
    const prev = this.spec;
    const next = rangeOf(spec);
    const relayout =
      prev !== null &&
      (prev.kind !== spec.kind || JSON.stringify(prev.unit) !== JSON.stringify(spec.unit));
    // A kind or unit change, or a pin cleared (Reset Y axis, the fit commit), releases the band.
    if (relayout || (rangeOf(prev) !== null && next === null)) this.held = null;
    this.spec = spec;
    if (this.gesture?.changed.y !== true) this.valueRange = next;
    this.committed = { window: this.committed.window, valueView: next, band: this.held };
    this.syncListeners();
  }

  /** True: the frame redraws as for any layout input (`layoutChanged`). */
  setTimeWindow(w: TimeWindow): boolean {
    if (this.disposed) return false;
    const win = { fromMs: w.fromMs, toMs: w.toMs };
    const g = this.gesture;
    if (g?.changed.x === true) {
      // The user's move wins at the commit, which compares the preview with this new base.
      this.window = win;
      this.setCommittedWindow(win);
      return false;
    }
    if (this.isBar()) {
      // A bar chart has no time axis: the window is stored, nothing is redrawn (ADR-0028).
      this.window = win;
      this.viewSpan = spanOf(win);
      this.setCommittedWindow(win);
      return false;
    }
    const base = this.window;
    if (g === null && (base === null || base.fromMs !== win.fromMs || base.toMs !== win.toMs)) {
      this.held = null;
    }
    this.window = win;
    this.viewSpan = spanOf(win);
    this.setCommittedWindow(win);
    return true;
  }

  resize(cssWidth: number, cssHeight: number): void {
    if (this.disposed) return;
    if (cssWidth !== this.cssW || cssHeight !== this.cssH) this.held = null;
    this.cssW = cssWidth;
    this.cssH = cssHeight;
  }

  /** A stored input changed: the frame redraws and the hover is cleared. */
  layoutChanged(): void {
    if (this.disposed) return;
    this.pointerAt = null;
    this.keyAt = null;
    this.bar?.clearMark();
    this.host.clearHover();
    this.host.redraw();
  }

  /**
   * The stage was withdrawn (plan #68 C2a2 §3.2): a running gesture is dropped without a commit
   * or brush, and the committed camera is restored.
   */
  abortGesture(): void {
    const g = this.gesture;
    if (g === null || this.disposed) return;
    if (g.kind === 'wheel') {
      this.deps.clearTimer(g.timer);
    } else {
      const target: { releasePointerCapture?: (id: number) => void } = this.canvas;
      try {
        target.releasePointerCapture?.(g.pointerId);
      } catch {
        // The capture was best effort.
      }
      this.clearRightPress();
    }
    this.gesture = null;
    delete this.canvas.dataset['gesture'];
    const c = this.committed;
    this.viewSpan = c.window === null ? null : spanOf(c.window);
    this.valueRange = c.valueView;
    this.held = c.band;
    this.host.redraw();
  }

  dispose(): void {
    if (this.disposed) return;
    // No commit after dispose: the gesture and its timers are dropped.
    if (this.gesture?.kind === 'wheel') this.deps.clearTimer(this.gesture.timer);
    this.gesture = null;
    this.clearRightPress();
    this.bar?.dispose();
    this.setListening(false);
    this.disposed = true;
  }

  private setCommittedWindow(win: TimeWindow): void {
    this.committed = { window: win, valueView: this.committed.valueView, band: this.held };
  }

  private syncListeners(): void {
    // A geomap's input is its scene's (ADR-0027): this time camera does not listen there.
    this.setListening(
      this.spec !== null && this.spec.kind !== 'stat' && this.spec.kind !== 'geomap',
    );
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

  // Camera (#93, plan §4.2).

  /** The plot and kind when the camera can act (a drawn, non-empty plot and a window). */
  private stage(): { plot: PlotRect; spec: VisSpec; model: StageModel; view: Span } | null {
    const model = this.host.model();
    const spec = this.spec;
    const view = this.viewSpan;
    if (model === null || spec === null || view === null) return null;
    const plot = model.plot;
    if (!(plot.width > 0) || !(plot.height > 0)) return null;
    return { plot, spec, model, view };
  }

  private zoneAt(p: Point): Zone {
    const s = this.stage();
    return s === null ? null : zoneOf(p, s.plot, s.spec.kind);
  }

  /** A preview step moved the view: hold the band of the frame on screen and redraw. */
  private previewed(): void {
    this.held ??= this.host.model()?.labelW ?? null;
    this.host.redraw();
    this.host.hover();
  }

  /** Time pans of a view narrower than the minimum span move whole ms (F1: the preview's span). */
  private timeStep(v: Span, plot: PlotRect): number {
    return v.hi - v.lo < timeLimits(plot.width).minSpan ? 1 : 0;
  }

  private setView(next: Span, changed: Changed): void {
    if (next === this.viewSpan) return;
    this.viewSpan = next;
    changed.x = true;
    this.previewed();
  }

  private setValueView(next: Span, changed: Changed): void {
    const cur = this.valueRange;
    if (cur !== null && next.lo === cur.min && next.hi === cur.max) return;
    this.valueRange = { min: next.lo, max: next.hi };
    changed.y = true;
    this.previewed();
  }

  /** Zooms time (`x`) and values (`y`) about `p`; values only on line and bars. */
  private zoomAt(changed: Changed, p: Point, x: boolean, y: boolean, k: number) {
    const s = this.stage();
    if (s === null) return;
    if (x) this.setView(zoomAbout(s.view, fx(s.plot, p.x), k, timeLimits(s.plot.width)), changed);
    const base = this.valueRange ?? s.model.valueDomain;
    if (y && base !== null && (s.spec.kind === 'line' || s.spec.kind === 'bars')) {
      const f = fy(s.plot, p.y);
      const anchor = base.min + f * (base.max - base.min);
      const next = zoomAbout({ lo: base.min, hi: base.max }, f, k, valueLimits(anchor));
      this.setValueView(next, changed);
    }
  }

  /** Starts a wheel gesture or continues it: the anchor moves to `p`; the idle timer is re-armed. */
  private wheelGesture(p: Point): WheelGesture {
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
      this.keyAt = null;
    }
    g.x = p.x;
    g.y = p.y;
    this.deps.clearTimer(g.timer);
    g.timer = this.deps.setTimer(() => {
      this.endWheel();
    }, WHEEL_IDLE_MS);
    // The pointer stays: hover follows it on every preview frame.
    this.pointerAt = this.zoneAt(p) === 'plot' ? p : null;
    this.host.hover();
    return g;
  }

  private endWheel(): void {
    const g = this.gesture;
    if (g?.kind !== 'wheel' || this.disposed) return;
    this.deps.clearTimer(g.timer);
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
    const v = this.viewSpan;
    if (changed.x && v !== null) {
      const w = toWindow(v);
      const base = this.window;
      if (base === null || base.fromMs !== w.fromMs || base.toMs !== w.toMs) window = w;
      this.window = w;
      this.viewSpan = spanOf(w);
    }
    const vv = this.valueRange;
    const value = changed.y && vv !== null && !sameRange(vv, rangeOf(this.spec)) ? vv : null;
    // The same view and held band: a redraw with whole-ms ends, no layout change.
    this.host.redraw();
    if (window !== null || value !== null) {
      this.committed = {
        window: this.window,
        valueView: value ?? this.committed.valueView,
        band: this.held,
      };
      this.deps.emit('commit', { window, value, gesture });
    }
  }

  private isBar(): boolean {
    return this.spec?.kind === 'barchart';
  }

  private onWheel(e: WheelEvent): void {
    if (this.isBar()) return;
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
    if (e.timeStamp - this.deps.wheelLatch.lastPageWheel() < PAGE_WHEEL_LATCH_MS) return;
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
    if (this.isBar() || this.gesture?.kind === 'press') return;
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

  private local(e: MouseEvent): Point {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private setZone(z: Zone): void {
    this.zone = z;
    if (z === null) delete this.canvas.dataset['zone'];
    else this.canvas.dataset['zone'] = z;
  }

  private onPointerMove(e: PointerEvent): void {
    const p = this.local(e);
    if (this.isBar()) {
      this.bar?.move(e, p);
      return;
    }
    const g = this.gesture;
    if (g?.kind === 'press') {
      if (e.pointerId === g.pointerId) this.pressMove(g, p);
      return;
    }
    const zone = this.zoneAt(p);
    if (zone !== this.zone) this.setZone(zone);
    this.keyAt = null;
    this.pointerAt = zone === 'plot' ? p : null;
    this.host.hover();
  }

  private pressMove(g: PressGesture, p: Point): void {
    g.x = p.x;
    g.y = p.y;
    g.travel = Math.max(g.travel, Math.hypot(p.x - g.x0, p.y - g.y0));
    if (!g.moved) {
      const d = g.press === 'pan-y' ? Math.abs(p.y - g.y0) : Math.abs(p.x - g.x0);
      if (d < DRAG_MIN_PX) return;
      g.moved = true;
    }
    const s = this.stage();
    if (s === null) return;
    switch (g.press) {
      case 'box':
        this.host.boxChanged();
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
    if (this.isBar()) {
      this.bar?.leave();
      return;
    }
    this.pointerAt = null;
    this.setZone(null);
    if (this.gesture === null && this.held !== null) {
      // The pointer left the chart: the band re-measures and full labels return.
      this.held = null;
      this.host.redraw();
    }
    this.host.hover();
  }

  private onPointerDown(e: PointerEvent): void {
    if (this.isBar()) {
      if (this.bar?.down(e, this.local(e)) === true) this.capture(e.pointerId);
      return;
    }
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
    this.capture(e.pointerId);
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
      click:
        e.button === 0 && zone === 'plot' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey,
      travel: 0,
      view0: this.viewSpan ?? s.view,
      value0: this.valueRange,
      domain0: s.model.valueDomain,
      changed: { x: false, y: false },
    };
    this.canvas.dataset['gesture'] =
      press === 'box' ? 'box' : press === 'pan-y' ? 'axis-y' : zone === 'x-axis' ? 'axis-x' : 'pan';
    this.keyAt = null;
    this.pointerAt = null;
    this.host.hover();
  }

  private onPointerUp(e: PointerEvent): void {
    if (this.isBar()) {
      this.bar?.up(e, this.local(e));
      return;
    }
    if (this.rightPress) this.armRightClear();
    const g = this.gesture;
    if (g?.kind !== 'press' || e.pointerId !== g.pointerId) return;
    this.gesture = null;
    delete this.canvas.dataset['gesture'];
    this.host.boxChanged();
    if (!g.moved) {
      const p = this.local(e);
      const travel = Math.max(g.travel, Math.hypot(p.x - g.x0, p.y - g.y0));
      // T25-005: a click selects the mark under it (null: an empty click).
      if (g.click && travel < DRAG_MIN_PX) this.host.select(p);
      return;
    }
    if (g.press === 'box') {
      this.boxZoom(g.x0, this.local(e).x);
      return;
    }
    this.commit(g.changed, g.zone === 'plot' ? 'pan' : 'axis');
  }

  private capture(pointerId: number): void {
    // Not every environment implements pointer capture (jsdom does not).
    const target: { setPointerCapture?: (id: number) => void } = this.canvas;
    try {
      target.setPointerCapture?.(pointerId);
    } catch {
      // Capture is best effort: a drag that leaves the canvas still ends on pointerup or cancel.
    }
  }

  /** The box zoom: the dragged span, snapped as the brush always was (≥ 1 s). */
  private boxZoom(x0: number, x: number): void {
    const plot = this.host.model()?.plot;
    const w = this.window;
    if (plot === undefined || w === null || Math.abs(x - x0) < DRAG_MIN_PX) return;
    const span = w.toMs - w.fromMs;
    const at = (px: number): number =>
      Math.min(w.toMs, Math.max(w.fromMs, w.fromMs + ((px - plot.x) / plot.width) * span));
    const u = brushSnapUnit(span / plot.width);
    const snap = (t: number): number => Math.round(t / u) * u;
    const fromMs = snap(Math.min(at(x0), at(x)));
    const toMs = snap(Math.max(at(x0), at(x)));
    if (toMs - fromMs >= MIN_BRUSH_MS) this.deps.emit('brush', { fromMs, toMs, gesture: 'drag' });
  }

  /** Escape, `pointercancel`, `lostpointercapture`: the press ends; view, value and band restored. */
  private cancelPress(): boolean {
    this.bar?.cancel();
    const g = this.gesture;
    if (g?.kind !== 'press') return false;
    this.gesture = null;
    delete this.canvas.dataset['gesture'];
    if (g.moved) {
      this.viewSpan = this.window === null ? null : spanOf(this.window);
      this.valueRange = g.value0;
      // The camera move is undone: the band re-measures and full labels return.
      this.held = null;
      this.host.redraw();
    }
    this.host.boxChanged();
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
    if (this.rightTimer !== null) this.deps.clearTimer(this.rightTimer);
    this.rightTimer = this.deps.setTimer(() => {
      this.rightTimer = null;
      this.rightPress = false;
    }, 0);
  }

  private clearRightPress(): void {
    this.rightPress = false;
    if (this.rightTimer !== null) this.deps.clearTimer(this.rightTimer);
    this.rightTimer = null;
  }

  private onDoubleClick(e: MouseEvent): void {
    if (this.isBar()) return;
    const w = this.window;
    const zone = this.zoneAt(this.local(e));
    if (w === null) return;
    if (zone === 'plot') {
      const width = w.toMs - w.fromMs;
      const fromMs = w.fromMs - Math.floor(width / 2);
      this.deps.emit('brush', { fromMs, toMs: fromMs + 2 * width, gesture: 'zoomOut' });
      return;
    }
    if (zone !== 'y-axis' || (this.valueRange === null && rangeOf(this.spec) === null)) return;
    // The value axis back to auto (INT-008).
    this.valueRange = null;
    this.host.redraw();
    this.committed = { window: this.window, valueView: null, band: this.held };
    this.deps.emit('commit', { window: null, value: 'auto', gesture: 'fit' });
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (this.isBar()) {
      this.bar?.key(e);
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const n = this.host.model()?.pickCount ?? 0;
    const i = this.keyAt;
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
          this.keyAt = null;
          this.host.hover();
        }
        return;
      }
      default:
        return;
    }
    if (next === undefined || n === 0) return;
    e.preventDefault();
    this.keyAt = Math.min(n - 1, Math.max(0, next));
    this.pointerAt = null;
    this.host.hover();
  }

  private onFocus(): void {
    if (this.isBar()) this.bar?.focus();
  }

  private onFocusOut(): void {
    if (this.isBar()) {
      this.bar?.blur();
      return;
    }
    if (this.keyAt === null) return;
    this.keyAt = null;
    this.host.hover();
  }
}
