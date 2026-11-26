/**
 * The interim Canvas 2D chart engine (ADR-0014 §3, §4; T01-003 interim exception, until #68). One
 * `Canvas2DFrame` per `<canvas>`, on the main thread. Inputs only store values and schedule one
 * frame; the frame redraws a cached layer when an input changed, then blits it and draws the
 * overlay (crosshair, hover dots, box band), and reports the completed draw (`drawn`, ADR-0019).
 *
 * The interim 2D camera (#93, T02 §4.6, ADR-0020) is the shared `FrameController`
 * (`controller/controller.ts`, plan #68 C2a2): a view (time window and value range) previewed every
 * frame from the resident data while a wheel, pinch, swipe or drag is worked, and committed once at
 * the gesture's end (`commit`: wheel idle 300 ms, pointer up). The value-label band is held from the
 * first camera move until a layout transition, so the plot does not move under the pointer (T02-011
 * as amended, T02-021). Windows and ranges it proposes go out as `brush` and `commit` events; the
 * application changes the Context and the pin. This frame is its `Stage`: the last drawn layer.
 *
 * Event markers (ADR-0023, `setEvents`) are drawn with the layer, through the drawn view, so they
 * follow the preview; their labels' boxes go out in the `a11y` summary (`eventLabels`).
 *
 * A bar chart (ADR-0028, ADR-0029) has no camera: its pointer events and its key target's keys go
 * to `BarInput` (`mark`, `pick`, the focus mark and the brush band in the overlay), and its wheel,
 * gestures, double click and context menu are ignored.
 */
import type {
  ChartEngine,
  ChartFrame,
  EventMarker,
  FrameData,
  FrameEvents,
  FrameInit,
  FrameSelection,
  HoverEvent,
  ThemeName,
  TimeWindow,
  VisSpec,
} from '../api';
import { FrameController } from '../controller/controller';
import type { BarHooks, Point, Stage, StageModel } from '../controller/stage';
import { BarInput } from './barInput';
import { drawBarOverlay, type BarPick } from './barchart';
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
import { windowWheelLatch, type WheelLatch } from './input';
import { hoverAt } from './pick';
import { themeColours } from './palette';
import { sameSelection, type Listener } from './gesture';
import { pickItem } from './select';

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

/** The page's wheel latch: one passive window listener, created with the first frame. */
let pageLatch: WheelLatch | null = null;
/** The page's wheel latch (shared with `ControlledFrame`'s default). */
export function defaultLatch(): WheelLatch {
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

class Canvas2DFrame implements ChartFrame {
  private readonly ctx: Ctx2D;
  private readonly layer: HTMLCanvasElement;
  private readonly layerCtx: Ctx2D;
  /** The dim layer's scratch canvas (plan #68 C2c2 §1, ADR-0032): 0×0 unless a selection dims. */
  private readonly scratch: HTMLCanvasElement;
  private readonly scratchCtx: Ctx2D;
  private spec: VisSpec | null = null;
  private data: FrameData | null = null;
  /** The last `setEvents` (ADR-0023); [] = none. */
  private events: readonly EventMarker[] = [];
  /** The last `setSelection` (ADR-0025); null = none. */
  private selection: FrameSelection | null = null;
  private theme: ThemeName = 'dark';
  private cssW = 0;
  private cssH = 0;
  private dpr = 1;
  private layerDirty = false;
  private hoverDirty = false;
  private scheduled: number | null = null;
  private disposed = false;
  private model: LayerModel | null = null;
  /** What the controller reads of `model` (plan #68 C2a2 §3.1). */
  private stageModel: StageModel | null = null;
  private summaryKey = '';
  private lastHover: HoverEvent | null = null;
  private readonly listeners = new Map<keyof FrameEvents, Set<Listener>>();
  /** The bar chart's `mark` and `pick` (ADR-0028). */
  private readonly bar = new BarInput(this.emit.bind(this), () => {
    this.schedule();
  });
  /** The camera (#93): the shared controller, this frame its stage. */
  private readonly ctl: FrameController;

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
    this.scratch = r.createCanvas();
    const scratchCtx = r.contextOf(this.scratch);
    if (scratchCtx === null) throw new ChartUnsupportedError('no 2D context for the dim layer');
    this.scratchCtx = scratchCtx;
    this.scratch.width = 0;
    this.scratch.height = 0;
    const hooks: BarHooks = {
      down: (e, p) => this.bar.down(e, p, this.barPick()),
      move: (e, p) => {
        this.bar.move(this.barPick(), e.pointerId, p);
      },
      up: (e, p) => {
        this.bar.up(this.barPick(), e.pointerId, p);
      },
      cancel: () => {
        this.bar.cancel();
      },
      clearMark: () => {
        this.bar.clearMark();
      },
      leave: () => {
        this.bar.hoverEnd(this.barPick());
      },
      key: (e) => {
        this.bar.key(e, this.barPick());
      },
      focus: () => {
        this.bar.focusIn(this.barPick());
      },
      blur: () => {
        this.bar.blur();
      },
      dispose: () => {
        this.bar.dispose();
      },
    };
    const stage: Stage = {
      model: () => this.stageModel,
      redraw: () => {
        this.invalidate();
      },
      hover: () => {
        this.hoverDirty = true;
        this.schedule();
      },
      clearHover: () => {
        this.clearHover();
      },
      select: (p) => {
        this.select(p);
      },
      boxChanged: () => {
        this.schedule();
      },
    };
    this.ctl = new FrameController(
      canvas,
      init,
      stage,
      {
        now: r.now,
        setTimer: r.setTimer,
        clearTimer: r.clearTimer,
        wheelLatch: r.wheelLatch,
        emit: this.emit.bind(this),
      },
      hooks,
    );
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
    this.spec = spec;
    this.ctl.setSpec(spec);
    this.changed();
  }

  setData(data: FrameData): void {
    if (this.disposed) return;
    this.data = data;
    this.bar.newData();
    this.changed();
  }

  setTimeWindow(w: TimeWindow): void {
    if (this.disposed) return;
    if (this.ctl.setTimeWindow(w)) this.changed();
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

  /** ADR-0025: drawn in the layer pass of the next frame; an equal selection redraws nothing. */
  setSelection(sel: FrameSelection | null): void {
    if (this.disposed || sameSelection(sel, this.selection)) return;
    this.selection =
      sel === null ? null : { keys: [...sel.keys], fromMs: sel.fromMs, toMs: sel.toMs };
    this.invalidate();
  }

  setTheme(t: ThemeName): void {
    if (this.disposed) return;
    this.theme = t;
    this.changed();
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    if (this.disposed) return;
    this.ctl.resize(cssWidth, cssHeight);
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
    // No commit after dispose: the controller drops the gesture and its timers.
    this.ctl.dispose();
    this.listeners.clear();
    for (const c of [this.canvas, this.layer, this.scratch]) {
      c.width = 0;
      c.height = 0;
    }
    this.model = null;
    this.stageModel = null;
  }

  // Stage (plan #68 C2a2 §3.1).

  private clearHover(): void {
    if (this.lastHover !== null) {
      this.lastHover = null;
      this.emit('hover', null);
    }
  }

  /** A click (T25-005): the mark under it, once a layer is drawn with a view. */
  private select(p: Point): void {
    const v = this.ctl.view;
    if (this.model !== null && v !== null) {
      this.emit('select', { source: 'pointer', item: pickItem(this.model, v, p) });
    }
  }

  // Inputs.

  private emit<E extends keyof FrameEvents>(e: E, ev: FrameEvents[E]): void {
    for (const cb of [...(this.listeners.get(e) ?? [])]) (cb as (x: FrameEvents[E]) => void)(ev);
  }

  /** A stored input changed: redraw the layer and clear the hover. */
  private changed(): void {
    this.ctl.layoutChanged();
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
      this.setModel(this.drawLayer());
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
      if (this.spec?.kind === 'barchart') this.bar.laidOut(this.barPick());
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

  private setModel(m: LayerModel | null): void {
    this.model = m;
    this.stageModel =
      m === null
        ? null
        : {
            plot: m.summary.plot,
            valueDomain: m.valueDomain,
            labelW: m.labelW,
            pickCount: m.pick?.ref.length ?? 0,
          };
  }

  private drawLayer(): LayerModel | null {
    const ctx = this.layerCtx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const colours = themeColours(this.theme);
    // A bar chart has no time axis: it draws without a window (ADR-0028).
    const v = this.ctl.view ?? (this.spec?.kind === 'barchart' ? { lo: 0, hi: 0 } : null);
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
      valueRange: valueAxis ? this.ctl.valueView : null,
      band: this.spec.kind === 'stat' ? null : this.ctl.bandHold,
      // T02-011: the band is at least the widest compact label of the unit.
      minBand: this.spec.kind === 'stat' ? 0 : minValueBand(ctx, this.spec.unit),
      events: this.events,
      selection: this.selection,
      dpr: this.dpr,
    });
  }

  private drawVisible(hover: HoverEvent | null): void {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.drawImage(this.layer, 0, 0, this.cssW, this.cssH);
    if (this.model === null) return;
    const bar = this.barPick();
    if (bar !== null) drawBarOverlay(ctx, bar, themeColours(this.theme), this.bar.overlay());
    else drawOverlay(ctx, this.model, themeColours(this.theme), hover, this.ctl.box());
  }

  private currentHover(): HoverEvent | null {
    const m = this.model;
    const v = this.ctl.view;
    if (m === null || v === null) return null;
    return hoverAt(m, v, this.ctl.keyIndex, this.ctl.pointer);
  }

  /** The bar chart's pick model, or null when this frame is not a drawn bar chart. */
  private barPick(): BarPick | null {
    const pick = this.model?.pick;
    return this.spec?.kind === 'barchart' && pick?.kind === 'barchart' ? pick : null;
  }
}
