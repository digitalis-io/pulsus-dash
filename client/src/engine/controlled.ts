/**
 * Stub (plan #68 C2a2, tests first): forwards to the engine frame as C2a1 did; the controller comes
 * with the implementation.
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
import type { ControllerDeps } from './controller/stage';
import type { EngineFrame } from './wasm/frame';

export class ControlledFrame implements ChartFrame {
  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly init: FrameInit,
    readonly inner: EngineFrame,
    readonly deps: Partial<Omit<ControllerDeps, 'emit'>> = {},
  ) {}
  setSpec(spec: VisSpec): void {
    this.inner.setSpec(spec);
  }
  setData(data: FrameData): void {
    this.inner.setData(data);
  }
  setTimeWindow(w: TimeWindow): void {
    (this.inner as Partial<ChartFrame>).setTimeWindow?.(w);
  }
  setTheme(t: ThemeName): void {
    this.inner.setTheme(t);
  }
  setEvents(events: readonly EventMarker[]): void {
    this.inner.setEvents(events);
  }
  setSelection(sel: FrameSelection | null): void {
    this.inner.setSelection(sel);
  }
  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.inner.resize(cssWidth, cssHeight, dpr);
  }
  on<E extends keyof FrameEvents>(e: E, cb: (ev: FrameEvents[E]) => void): () => void {
    if (e !== 'a11y' && e !== 'drawn') return () => undefined;
    return this.inner.on(e as 'a11y', cb as (ev: FrameEvents['a11y']) => void);
  }
  dispose(): void {
    this.inner.dispose();
  }
}
