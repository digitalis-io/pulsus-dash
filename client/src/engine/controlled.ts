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
 * Hover, select and the box band are not drawn by the engine yet (C2b): those stage calls are
 * no-ops. `brush` and `commit` come from the controller; `a11y` and `drawn` from the engine frame.
 */
import type {
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

  constructor(
    canvas: HTMLCanvasElement,
    init: FrameInit,
    private readonly inner: EngineFrame,
    deps: Partial<Omit<ControllerDeps, 'emit'>> & { defer?: (cb: () => void) => void } = {},
  ) {
    const stage: Stage = {
      model: () => inner.stage(),
      redraw: () => {
        const c = this.controller;
        const view = c.view;
        if (view !== null) inner.setCamera({ view, value: c.valueView, band: c.bandHold });
      },
      hover: () => undefined,
      clearHover: () => undefined,
      select: () => undefined,
      boxChanged: () => undefined,
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
    );
  }

  /** Stub (plan #68 C2b): writes the batched camera, then the overlay. */
  flush(): void {
    // Not batched until C2b.
  }

  setSpec(spec: VisSpec): void {
    if (this.disposed) return;
    this.controller.setSpec(spec);
    this.controller.layoutChanged();
    this.inner.setSpec(spec);
  }

  setData(data: FrameData): void {
    if (this.disposed) return;
    this.controller.layoutChanged();
    this.inner.setData(data);
  }

  setTimeWindow(w: TimeWindow): void {
    if (this.disposed) return;
    if (this.controller.setTimeWindow(w)) this.controller.layoutChanged();
  }

  setTheme(t: ThemeName): void {
    if (this.disposed) return;
    this.controller.layoutChanged();
    this.inner.setTheme(t);
  }

  setEvents(events: readonly EventMarker[]): void {
    if (this.disposed) return;
    this.inner.setEvents(events);
  }

  setSelection(sel: FrameSelection | null): void {
    if (this.disposed) return;
    this.inner.setSelection(sel);
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    if (this.disposed) return;
    this.controller.resize(cssWidth, cssHeight);
    this.controller.layoutChanged();
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
