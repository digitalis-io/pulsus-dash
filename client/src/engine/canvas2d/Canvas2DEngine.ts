/**
 * The interim Canvas 2D chart engine (ADR-0014 §3, §4; T01-003 interim exception, until #68). One
 * `Canvas2DFrame` per `<canvas>`, on the main thread. Inputs only store values and schedule one
 * frame; the frame redraws a cached layer when an input changed, then blits it and draws the
 * overlay (crosshair, hover dots, box band), and reports the completed draw (`drawn`, ADR-0019).
 * A canvas whose 2D context the browser lost and restored (`contextrestored`) is blank: the frame
 * draws the layer and the visible canvas again from its stored inputs (#296).
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
 *
 * A geomap (ADR-0027, plan #234 Part 2 §4.1) is drawn by its scene (`geo/scene.ts`), imported on the
 * frame's first `geomap` spec (`loadGeoModule`). The frame stores and forwards its inputs; the
 * scene owns the camera and input and paints the visible canvas directly (no layer cache). Until the
 * module resolves the frame paints `map-water` and reports no `drawn`. Each load takes a generation
 * (`geoGen`); leaving the kind and `dispose` bump it, so a late module attaches nothing.
 */
import type {
  CameraKey,
  ChartEngine,
  ChartFrame,
  EventMarker,
  FrameData,
  FrameEvents,
  FrameInit,
  FrameSelection,
  FrameSummary,
  HoverEvent,
  PlotRect,
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
  releaseScratch,
  STAT_FONT,
  type DimScratch,
  type LayerModel,
} from './draw';
import { windowWheelLatch, type WheelLatch } from './input';
import { hoverAt } from './pick';
import { themeColours } from './palette';
import { sameSelection, type Listener } from './gesture';
import { pickItem } from './select';
import type { GeoScene } from './geo/scene';

/** The data crossfade's length, ms (ADR-0039, T02-007). */
const FADE_MS = 150;

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
  /** The geomap scene module (plan #234 Part 2 §3.1); default `loadGeoModule`. */
  loadGeo?: () => Promise<GeoModule>;
}

/** The geomap scene's dynamic entry (ADR-0027): imported on a frame's first `geomap` spec. */
export type GeoModule = typeof import('./geo/scene');

/**
 * A loader of the geo module over `imp`: one shared promise, kept on success; a rejection clears
 * it, so the next call imports again (plan #234 Part 2 §3.1).
 */
export function geoModuleLoader(imp: () => Promise<GeoModule>): () => Promise<GeoModule> {
  let pending: Promise<GeoModule> | null = null;
  return () => {
    if (pending === null) {
      const p = imp();
      pending = p;
      p.catch(() => {
        if (pending === p) pending = null;
      });
    }
    return pending;
  };
}

/** The page's geo module loader. */
export const loadGeoModule: () => Promise<GeoModule> = geoModuleLoader(() => import('./geo/scene'));

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
  loadGeo: () => Promise<GeoModule>;
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
      loadGeo: o.loadGeo ?? loadGeoModule,
    };
    return new Canvas2DFrame(canvas, init, r);
  }
}

class Canvas2DFrame implements ChartFrame {
  private readonly ctx: Ctx2D;
  private readonly layer: HTMLCanvasElement;
  private readonly layerCtx: Ctx2D;
  /** The dim layer's scratch canvas (plan #68 C2c2 §1, ADR-0032): 0×0 unless a selection dims. */
  private readonly dim: DimScratch;
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
  /**
   * A data crossfade in progress (ADR-0039, T02-007): the series layer drawn before, kept as a
   * bitmap, composited over the new layer at 1 − t within the plot for 150 ms.
   */
  private fade: {
    readonly canvas: HTMLCanvasElement;
    readonly startMs: number;
    readonly plot: PlotRect;
  } | null = null;
  private readonly listeners = new Map<keyof FrameEvents, Set<Listener>>();
  /** The bar chart's `mark` and `pick` (ADR-0028). */
  private readonly bar = new BarInput(this.emit.bind(this), () => {
    this.schedule();
  });
  /** The camera (#93): the shared controller, this frame its stage. */
  private readonly ctl: FrameController;
  /** A geomap's scene (ADR-0027), once its module resolved for the current generation. */
  private geo: GeoScene | null = null;
  /** Bumped by each geo load, by leaving `geomap` and by `dispose` (the lifecycle guard). */
  private geoGen = 0;
  /** The generation of the load in flight; null: none. */
  private geoPending: number | null = null;
  private geoFocus: string | null = null;
  /** The scene's last hover was a mark: leaving the kind clears it. */
  private geoHover = false;

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
    const scratch = r.createCanvas();
    const scratchCtx = r.contextOf(scratch);
    if (scratchCtx === null) throw new ChartUnsupportedError('no 2D context for the dim layer');
    this.dim = { canvas: scratch, ctx: scratchCtx };
    releaseScratch(this.dim);
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
    // A lost 2D context comes back blank (`contextrestored`, HTML canvas): repaint the layer and
    // the visible canvas from the stored inputs (#296). Nothing else redraws a frame whose inputs
    // did not change, such as a stat that only scrolled out of view and back.
    for (const c of [canvas, this.layer]) c.addEventListener('contextrestored', this.onRestored);
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
    if (prev?.kind === 'geomap' && spec.kind !== 'geomap') this.leaveGeo();
    this.spec = spec;
    this.ctl.setSpec(spec);
    if (spec.kind === 'geomap') {
      if (this.geo !== null) this.geo.setSpec(spec);
      else this.loadGeo();
      this.schedule();
      return;
    }
    this.changed();
  }

  setData(data: FrameData): void {
    if (this.disposed) return;
    this.endFade();
    if (
      data.kind === 'series' &&
      data.transition === 'crossfade' &&
      this.spec?.kind === 'line' &&
      this.model !== null &&
      this.layer.width > 0 &&
      this.layer.height > 0
    ) {
      this.startFade(this.model.summary.plot);
    }
    this.data = data;
    if (this.spec?.kind === 'geomap') {
      if (data.kind === 'geo') this.geo?.setData(data.geo);
      return;
    }
    this.bar.newData();
    this.changed();
  }

  setTimeWindow(w: TimeWindow): void {
    if (this.disposed) return;
    // A camera change ends a fade at once: input never waits for it (PRF-003).
    this.endFade();
    // A geomap stores the window and draws nothing for it (ADR-0027 (2)).
    if (this.ctl.setTimeWindow(w) && this.spec?.kind !== 'geomap') this.changed();
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
    if (this.spec?.kind === 'geomap') return;
    if (band) this.changed();
    else this.invalidate();
  }

  /** ADR-0025: drawn in the layer pass of the next frame; an equal selection redraws nothing. */
  setSelection(sel: FrameSelection | null): void {
    if (this.disposed || sameSelection(sel, this.selection)) return;
    this.selection =
      sel === null ? null : { keys: [...sel.keys], fromMs: sel.fromMs, toMs: sel.toMs };
    if (this.spec?.kind === 'geomap') {
      this.geo?.setSelection(this.selection);
      return;
    }
    this.invalidate();
  }

  setTheme(t: ThemeName): void {
    if (this.disposed) return;
    this.theme = t;
    if (this.spec?.kind === 'geomap') {
      this.geo?.setTheme(t);
      this.schedule();
      return;
    }
    this.changed();
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    if (this.disposed) return;
    this.endFade();
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
    if (w === 0 || h === 0) releaseScratch(this.dim);
    if (this.spec?.kind === 'geomap') {
      this.geo?.resize(cssWidth, cssHeight, dpr);
      this.schedule();
      return;
    }
    this.changed();
  }

  /** ADR-0027: a geomap's focus ring and zoom anchor; kept until the scene exists; a no-op elsewhere. */
  setFocusMark(id: string | null): void {
    if (this.disposed) return;
    this.geoFocus = id;
    if (this.spec?.kind === 'geomap') this.geo?.setFocusMark(id);
  }

  /**
   * ADR-0027: one geomap camera key; a no-op on other kinds, and while the scene is still loading
   * (or has no size yet): a key is an action on the map shown, not a queued command.
   */
  cameraKey(k: CameraKey): void {
    if (this.disposed || this.spec?.kind !== 'geomap') return;
    this.geo?.cameraKey(k);
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
    this.endFade();
    this.disposed = true;
    this.geoGen += 1;
    this.geoPending = null;
    this.geo?.dispose();
    this.geo = null;
    if (this.scheduled !== null) this.r.cancelFrame(this.scheduled);
    this.scheduled = null;
    // No commit after dispose: the controller drops the gesture and its timers.
    this.ctl.dispose();
    this.listeners.clear();
    releaseScratch(this.dim);
    for (const c of [this.canvas, this.layer]) {
      c.removeEventListener('contextrestored', this.onRestored);
      c.width = 0;
      c.height = 0;
    }
    this.model = null;
    this.stageModel = null;
  }

  // Geomap (ADR-0027, plan #234 Part 2 §4.1).

  /** Imports the scene for this generation; nothing attaches if the generation moved on. */
  private loadGeo(): void {
    if (this.geoPending !== null) return;
    this.geoGen += 1;
    const gen = this.geoGen;
    this.geoPending = gen;
    this.r.loadGeo().then(
      (mod) => {
        if (gen !== this.geoGen || this.disposed || this.spec?.kind !== 'geomap') return;
        this.geoPending = null;
        this.attachGeo(mod);
      },
      (e: unknown) => {
        if (gen !== this.geoGen) return;
        // The frame stays blank with no `drawn`; the next geomap spec imports again.
        this.geoPending = null;
        console.warn(
          `pulsus map renderer unavailable: ${e instanceof Error ? e.message : String(e)}`,
        );
        // The producer contract (plan #234 Part 3 §4.4a): one summary with no geo part tells the
        // host the renderer could not load, only for the live geomap of this generation.
        if (this.disposed || this.spec?.kind !== 'geomap') return;
        const failed: FrameSummary = {
          kind: 'geomap',
          geo: null,
          seriesTotal: 0,
          seriesShown: 0,
          fromMs: 0,
          toMs: 0,
          min: null,
          max: null,
          last: null,
          plot: { x: 0, y: 0, width: this.cssW, height: this.cssH },
          valueAxis: null,
          thresholdLabels: [],
          eventLabels: [],
        };
        this.summaryKey = JSON.stringify(failed);
        this.emit('a11y', failed);
      },
    );
  }

  /** Creates the scene and replays the spec, data, theme, size, selection and focus mark. */
  private attachGeo(mod: GeoModule): void {
    const spec = this.spec;
    if (spec?.kind !== 'geomap') return;
    const r = this.r;
    const scene = mod.createGeoScene({
      canvas: this.canvas,
      keyTarget: this.init.keyTarget,
      now: r.now,
      setTimer: r.setTimer,
      clearTimer: r.clearTimer,
      wheelLatch: r.wheelLatch,
      emit: (e, ev) => {
        if (e === 'hover') this.geoHover = ev !== null;
        this.emit(e, ev);
      },
      requestDraw: () => {
        this.schedule();
      },
      createCanvas: r.createCanvas,
      contextOf: r.contextOf,
    });
    this.geo = scene;
    scene.setSpec(spec);
    if (this.data?.kind === 'geo') scene.setData(this.data.geo);
    scene.setTheme(this.theme);
    if (this.cssW > 0 && this.cssH > 0) scene.resize(this.cssW, this.cssH, this.dpr);
    scene.setSelection(this.selection);
    scene.setFocusMark(this.geoFocus);
    this.schedule();
  }

  /** Leaving `geomap`: the scene and its listeners go before the time camera listens again. */
  private leaveGeo(): void {
    this.geoGen += 1;
    this.geoPending = null;
    this.geo?.dispose();
    this.geo = null;
    if (this.geoHover) {
      this.geoHover = false;
      this.emit('hover', null);
    }
  }

  /** A geomap frame: the scene paints the visible canvas; `map-water` until it exists. */
  private geoFrame(): void {
    const ctx = this.ctx;
    const scene = this.geo;
    if (scene === null) {
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.fillStyle = themeColours(this.theme).map.water;
      ctx.fillRect(0, 0, this.cssW, this.cssH);
      return;
    }
    const start = this.r.now();
    const summary = scene.draw(ctx);
    const end = this.r.now();
    try {
      performance.measure('chart-draw', {
        start,
        end,
        detail: { kind: 'geomap', series: summary.geo?.marks ?? 0, frame: this.init.id ?? null },
      });
      performance.clearMeasures('chart-draw');
    } catch {
      // The User Timing API is optional: drawing does not depend on it.
    }
    const key = JSON.stringify(summary);
    if (key !== this.summaryKey) {
      this.summaryKey = key;
      this.emit('a11y', summary);
    }
    this.presented();
    if (scene.animating()) this.schedule();
  }

  /** The visible canvas is complete at this size (ADR-0019). */
  private presented(): void {
    // The frame benches time presented frames by this mark (plan #68 C2d1 §1).
    try {
      performance.mark('chart-present', { detail: { frame: this.init.id ?? null } });
      performance.clearMarks('chart-present');
    } catch {
      // The User Timing API is optional: drawing does not depend on it.
    }
    this.emit('drawn', { cssWidth: this.cssW, cssHeight: this.cssH, dpr: this.dpr });
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

  /** A canvas's 2D context was restored with a blank bitmap: draw everything again. */
  private readonly onRestored = (): void => {
    this.invalidate();
  };

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
    if (this.spec?.kind === 'geomap') {
      this.layerDirty = false;
      this.geoFrame();
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
    // Never at a zero size or disposed.
    this.presented();
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
    // The dim layer exists only while a line layer dims (ADR-0032).
    if (this.spec?.kind !== 'line') releaseScratch(this.dim);
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
      scratch: this.dim,
    });
  }

  /** Keeps the drawn layer as the fade's bitmap (ADR-0039). */
  private startFade(plot: PlotRect): void {
    const canvas = this.r.createCanvas();
    canvas.width = this.layer.width;
    canvas.height = this.layer.height;
    const c = this.r.contextOf(canvas);
    if (c === null) return;
    c.drawImage(this.layer, 0, 0);
    this.fade = { canvas, startMs: this.r.now(), plot };
  }

  private endFade(): void {
    if (this.fade === null) return;
    this.fade.canvas.width = 0;
    this.fade.canvas.height = 0;
    this.fade = null;
  }

  private drawVisible(hover: HoverEvent | null): void {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.drawImage(this.layer, 0, 0, this.cssW, this.cssH);
    const f = this.fade;
    if (f !== null) {
      const t = (this.r.now() - f.startMs) / FADE_MS;
      if (t >= 1) {
        this.endFade();
      } else {
        // The old series layer over the new one at 1 − t, inside the plot; the next frame follows.
        ctx.save();
        ctx.beginPath();
        ctx.rect(f.plot.x, f.plot.y, f.plot.width, f.plot.height);
        ctx.clip();
        ctx.globalAlpha = 1 - Math.max(0, t);
        ctx.drawImage(f.canvas, 0, 0, this.cssW, this.cssH);
        ctx.restore();
        this.schedule();
      }
    }
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
