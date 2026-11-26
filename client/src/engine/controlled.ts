/**
 * An engine frame with its camera controller (plan #68 C2a2 §3.2, §4; ADR-0030): #93's
 * `FrameController` runs on the main thread, where the canvas's DOM listeners are, and sends its
 * camera to the engine frame as a Camera record (`EngineFrame.setCamera`). Its stage is the
 * engine's last completed presentation (`EngineFrame.stage()`): while a new layout is submitted,
 * retried or awaiting its read-back, input keeps using the one on screen, as Canvas 2D uses its
 * last drawn layer. A withdrawn stage (null: none yet, an empty plot, a zero size) aborts a running
 * gesture and restores the committed camera; with no stage every gesture is ignored.
 *
 * | Call | Controller | Engine frame |
 * |---|---|---|
 * | `setSpec` | `setSpec`, then `layoutChanged` | `setSpec` |
 * | `setData`, `setTheme` | `layoutChanged` | same call |
 * | `setTimeWindow` | `setTimeWindow`, `layoutChanged` when it asks | — (the camera carries the view) |
 * | `resize` | `resize`, `layoutChanged` | `resize` |
 * | `setEvents`, `setSelection` | — | same call (kept, not drawn) |
 * | `dispose` | `dispose` | `dispose` |
 *
 * Hover, click select and the box band (plan #68 C2b §4.1): the controller's camera and overlay
 * changes are batched and written once per task (`flush`, scheduled with `defer`, default
 * `queueMicrotask`): at most one Camera and one Overlay record, in that order, and every
 * forwarding call above runs the controller, then `flush()`, then the engine frame's call. A
 * click flushes, then sends its Select. `clearHover` emits `hover: null` at once when a hover is
 * shown; the engine's `hover` events are forwarded unless null follows null (Canvas 2D's rule),
 * and its `select` answers as `{source: 'pointer', item}`. `brush` and `commit` come from the
 * controller; `a11y` and `drawn` from the engine frame.
 */
import type {
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
} from './api';
import { defaultLatch } from './canvas2d/Canvas2DEngine';
import { FrameController } from './controller/controller';
import type { ControllerDeps, Stage } from './controller/stage';
import type { EngineFrame } from './wasm/frame';

type Listener = (ev: never) => void;

export class ControlledFrame implements ChartFrame {
  private readonly controller: FrameController;
  private readonly listeners = new Map<keyof FrameEvents, Set<Listener>>();
  private readonly offs: (() => void)[] = [];
  private disposed = false;
  /** The batch (plan #68 C2b §4.1): what the next flush writes, and whether one is scheduled. */
  private cameraDirty = false;
  private overlayDirty = false;
  private scheduled = false;
  private readonly defer: (cb: () => void) => void;
  /** The last hover emitted (Canvas 2D's `lastHover`). */
  private lastHover: HoverEvent | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    init: FrameInit,
    private readonly inner: EngineFrame,
    deps: Partial<Omit<ControllerDeps, 'emit'>> & { defer?: (cb: () => void) => void } = {},
  ) {
    this.defer =
      deps.defer ??
      ((cb) => {
        queueMicrotask(cb);
      });
    const stage: Stage = {
      model: () => inner.stage(),
      redraw: () => {
        this.cameraDirty = true;
        this.schedule();
      },
      hover: () => {
        this.overlayDirty = true;
        this.schedule();
      },
      clearHover: () => {
        if (this.lastHover !== null) {
          this.lastHover = null;
          this.emit('hover', null);
        }
        this.overlayDirty = true;
        this.schedule();
      },
      select: (p) => {
        this.flush();
        if (!this.disposed) inner.select(p.x, p.y);
      },
      boxChanged: () => {
        this.overlayDirty = true;
        this.schedule();
      },
    };
    this.controller = new FrameController(
      canvas,
      init,
      stage,
      {
        now: deps.now ?? (() => performance.now()),
        setTimer: deps.setTimer ?? ((cb, ms) => Number(setTimeout(cb, ms))),
        clearTimer:
          deps.clearTimer ??
          ((id) => {
            clearTimeout(id);
          }),
        wheelLatch: deps.wheelLatch ?? defaultLatch(),
        emit: (e, ev) => {
          this.emit(e, ev);
        },
      },
      null,
    );
    this.offs.push(
      inner.onStage((s) => {
        if (s === null) this.controller.abortGesture();
      }),
      inner.on('a11y', (ev) => {
        this.emit('a11y', ev);
      }),
      inner.on('drawn', (ev) => {
        this.emit('drawn', ev);
      }),
      inner.on('hover', (ev) => {
        if (ev === null && this.lastHover === null) return;
        this.lastHover = ev;
        this.emit('hover', ev);
      }),
      inner.on('select', (ev) => {
        this.emit('select', { source: 'pointer', item: ev.item });
      }),
    );
  }

  /** The batched camera, then the overlay, to the engine frame now (plan #68 C2b §4.1). */
  flush(): void {
    if (this.disposed) return;
    const c = this.controller;
    if (this.cameraDirty) {
      this.cameraDirty = false;
      const view = c.view;
      if (view !== null) this.inner.setCamera({ view, value: c.valueView, band: c.bandHold });
    }
    if (this.overlayDirty) {
      this.overlayDirty = false;
      const key = c.keyIndex;
      const p = c.pointer;
      this.inner.setOverlay({
        hover:
          key !== null
            ? { kind: 'key', index: key }
            : p !== null
              ? { kind: 'pointer', x: p.x, y: p.y }
              : { kind: 'none' },
        box: c.box(),
      });
    }
  }

  /** One flush per task: the input events of a task write one Camera and one Overlay at most. */
  private schedule(): void {
    if (this.scheduled || this.disposed) return;
    this.scheduled = true;
    this.defer(() => {
      this.scheduled = false;
      this.flush();
    });
  }

  setSpec(spec: VisSpec): void {
    if (this.disposed) return;
    this.controller.setSpec(spec);
    this.controller.layoutChanged();
    this.flush();
    this.inner.setSpec(spec);
  }

  setData(data: FrameData): void {
    if (this.disposed) return;
    this.controller.layoutChanged();
    this.flush();
    this.inner.setData(data);
  }

  setTimeWindow(w: TimeWindow): void {
    if (this.disposed) return;
    if (this.controller.setTimeWindow(w)) this.controller.layoutChanged();
    this.flush();
  }

  setTheme(t: ThemeName): void {
    if (this.disposed) return;
    this.controller.layoutChanged();
    this.flush();
    this.inner.setTheme(t);
  }

  setEvents(events: readonly EventMarker[]): void {
    if (this.disposed) return;
    this.flush();
    this.inner.setEvents(events);
  }

  setSelection(sel: FrameSelection | null): void {
    if (this.disposed) return;
    this.flush();
    this.inner.setSelection(sel);
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    if (this.disposed) return;
    this.controller.resize(cssWidth, cssHeight);
    this.controller.layoutChanged();
    this.flush();
    this.inner.resize(cssWidth, cssHeight, dpr);
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
    this.controller.dispose();
    for (const off of this.offs.splice(0)) off();
    this.listeners.clear();
    this.inner.dispose();
  }

  private emit<E extends keyof FrameEvents>(e: E, ev: FrameEvents[E]): void {
    for (const cb of [...(this.listeners.get(e) ?? [])]) (cb as (x: FrameEvents[E]) => void)(ev);
  }
}
