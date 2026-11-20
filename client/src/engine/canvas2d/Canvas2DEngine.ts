/**
 * The interim Canvas 2D chart engine (ADR-0014 §3, §4; T01-003 interim exception, until #68). One
 * `Canvas2DFrame` per `<canvas>`, on the main thread. Inputs only store values and schedule one
 * frame; the frame redraws a cached layer when an input changed, then blits it and draws the
 * overlay (crosshair, hover dots, brush band). The frame owns render-local state only; windows it
 * proposes go out as `brush` events and the application changes the Context.
 */
import { size } from '../../styles/tokens';
import type {
  ChartEngine,
  ChartFrame,
  FrameData,
  FrameEvents,
  FrameInit,
  HoverEvent,
  ThemeName,
  TimeWindow,
  VisSpec,
} from '../api';
import { brushSnapUnit } from './columns';
import type { Ctx2D } from './ctx';
import { AXIS_FONT, drawLayer, drawOverlay, MAX_SERIES, STAT_FONT, type LayerModel } from './draw';
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
}

interface Resolved {
  requestFrame: (cb: () => void) => number;
  cancelFrame: (id: number) => void;
  contextOf: (c: HTMLCanvasElement) => Ctx2D | null;
  createCanvas: () => HTMLCanvasElement;
  fonts: Pick<FontFaceSet, 'load'> | null;
  now: () => number;
}

/** The smallest drag that brushes, CSS px. */
const BRUSH_MIN_PX = size['chart-brush-min'];
const MIN_BRUSH_MS = 1_000;

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
    };
    return new Canvas2DFrame(canvas, init, r);
  }
}

type Listener = (ev: never) => void;

class Canvas2DFrame implements ChartFrame {
  private readonly ctx: Ctx2D;
  private readonly layer: HTMLCanvasElement;
  private readonly layerCtx: Ctx2D;
  private spec: VisSpec | null = null;
  private data: FrameData | null = null;
  private window: TimeWindow | null = null;
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
  private brush: { x0: number; x: number } | null = null;
  private lastHover: HoverEvent | null = null;
  private listening = false;
  private readonly listeners = new Map<keyof FrameEvents, Set<Listener>>();
  private readonly canvasHandlers: readonly [string, (e: Event) => void][];
  private readonly keyHandlers: readonly [string, (e: Event) => void][];

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
    this.canvasHandlers = [
      [
        'pointerdown',
        (e) => {
          this.onPointerDown(e as PointerEvent);
        },
      ],
      [
        'pointermove',
        (e) => {
          this.onPointerMove(e as PointerEvent);
        },
      ],
      [
        'pointerup',
        (e) => {
          this.onPointerUp(e as PointerEvent);
        },
      ],
      [
        'pointercancel',
        () => {
          this.cancelBrush();
        },
      ],
      [
        'pointerleave',
        () => {
          this.onPointerLeave();
        },
      ],
      [
        'dblclick',
        (e) => {
          this.onDoubleClick(e as MouseEvent);
        },
      ],
    ];
    this.keyHandlers = [
      [
        'keydown',
        (e) => {
          this.onKeyDown(e as KeyboardEvent);
        },
      ],
      [
        'focusout',
        () => {
          this.onFocusOut();
        },
      ],
    ];
    for (const f of [AXIS_FONT, STAT_FONT]) {
      r.fonts?.load(f).then(
        () => {
          this.invalidate();
        },
        () => {
          this.invalidate();
        },
      );
    }
  }

  setSpec(spec: VisSpec): void {
    if (this.disposed) return;
    this.spec = spec;
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
    this.window = { fromMs: w.fromMs, toMs: w.toMs };
    this.changed();
  }

  setTheme(t: ThemeName): void {
    if (this.disposed) return;
    this.theme = t;
    this.changed();
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    if (this.disposed) return;
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
    const method = on ? 'addEventListener' : 'removeEventListener';
    for (const [type, fn] of this.canvasHandlers) this.canvas[method](type, fn);
    const target = this.init.keyTarget;
    if (target !== null) for (const [type, fn] of this.keyHandlers) target[method](type, fn);
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
            detail: { kind: this.model.summary.kind, series: this.model.summary.seriesShown },
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
  }

  private drawLayer(): LayerModel | null {
    const ctx = this.layerCtx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const colours = themeColours(this.theme);
    if (this.spec === null || this.data === null || this.window === null) {
      ctx.fillStyle = colours.background;
      ctx.fillRect(0, 0, this.cssW, this.cssH);
      return null;
    }
    return drawLayer({
      ctx,
      spec: this.spec,
      data: this.data,
      window: this.window,
      cssW: this.cssW,
      cssH: this.cssH,
      timeZone: this.init.timeZone,
      colours,
    });
  }

  private drawVisible(hover: HoverEvent | null): void {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.drawImage(this.layer, 0, 0, this.cssW, this.cssH);
    if (this.model !== null)
      drawOverlay(ctx, this.model, themeColours(this.theme), hover, this.brush);
  }

  private currentHover(): HoverEvent | null {
    const m = this.model;
    const w = this.window;
    if (m === null || m.pick === null || w === null) return null;
    const { plot } = m.summary;
    const xOf = (t: number): number => plot.x + ((t - w.fromMs) / (w.toMs - w.fromMs)) * plot.width;
    if (this.keyIndex !== null) {
      const { tMs, rows } = hoverRows(m.pick, this.keyIndex, 'keyboard', plot.y);
      return { source: 'keyboard', tMs, xCss: xOf(tMs), yCss: plot.y, rows };
    }
    const p = this.pointer;
    if (p === null) return null;
    const t = w.fromMs + ((p.x - plot.x) / plot.width) * (w.toMs - w.fromMs);
    const i = m.pick.kind === 'line' ? nearestIndex(m.pick.ref, t) : bucketIndex(m.pick.ref, t);
    if (i < 0) return null;
    const { tMs, rows } = hoverRows(m.pick, i, 'pointer', p.y);
    return { source: 'pointer', tMs, xCss: xOf(tMs), yCss: p.y, rows };
  }

  // Pointer and keys.

  private local(e: MouseEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private inPlot(p: { x: number; y: number }): boolean {
    const plot = this.model?.summary.plot;
    if (plot === undefined) return false;
    return (
      p.x >= plot.x && p.x <= plot.x + plot.width && p.y >= plot.y && p.y <= plot.y + plot.height
    );
  }

  private hoverChanged(): void {
    this.hoverDirty = true;
    this.schedule();
  }

  private onPointerMove(e: PointerEvent): void {
    const p = this.local(e);
    if (this.brush !== null) {
      this.brush = { x0: this.brush.x0, x: p.x };
      this.schedule();
      return;
    }
    this.keyIndex = null;
    this.pointer = this.inPlot(p) ? p : null;
    this.hoverChanged();
  }

  private onPointerLeave(): void {
    this.pointer = null;
    this.hoverChanged();
  }

  private onPointerDown(e: PointerEvent): void {
    const p = this.local(e);
    if (e.button !== 0 || !this.inPlot(p)) return;
    // Not every environment implements pointer capture (jsdom does not).
    const target: { setPointerCapture?: (id: number) => void } = this.canvas;
    try {
      target.setPointerCapture?.(e.pointerId);
    } catch {
      // Capture is best effort: a drag that leaves the canvas still ends on pointerup or cancel.
    }
    this.brush = { x0: p.x, x: p.x };
    this.schedule();
  }

  private onPointerUp(e: PointerEvent): void {
    const b = this.brush;
    if (b === null) return;
    this.brush = null;
    this.schedule();
    const x = this.local(e).x;
    const plot = this.model?.summary.plot;
    const w = this.window;
    if (plot === undefined || w === null || Math.abs(x - b.x0) < BRUSH_MIN_PX) return;
    const span = w.toMs - w.fromMs;
    const at = (px: number): number =>
      Math.min(w.toMs, Math.max(w.fromMs, w.fromMs + ((px - plot.x) / plot.width) * span));
    const u = brushSnapUnit(span / plot.width);
    const snap = (t: number): number => Math.round(t / u) * u;
    const fromMs = snap(Math.min(at(b.x0), at(x)));
    const toMs = snap(Math.max(at(b.x0), at(x)));
    if (toMs - fromMs >= MIN_BRUSH_MS) this.emit('brush', { fromMs, toMs, gesture: 'drag' });
  }

  private cancelBrush(): boolean {
    if (this.brush === null) return false;
    this.brush = null;
    this.schedule();
    return true;
  }

  private onDoubleClick(e: MouseEvent): void {
    const w = this.window;
    if (w === null || !this.inPlot(this.local(e))) return;
    const width = w.toMs - w.fromMs;
    const fromMs = w.fromMs - Math.floor(width / 2);
    this.emit('brush', { fromMs, toMs: fromMs + 2 * width, gesture: 'zoomOut' });
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
        const dragging = this.cancelBrush();
        if (i === null && !dragging) return;
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
