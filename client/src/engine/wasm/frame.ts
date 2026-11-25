/** The main-thread side of one engine frame (plan #68 C1 §3.5). */
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
} from '../api';
import type { MainToRender, RenderEvent } from './protocol';

export interface Port {
  postMessage(msg: MainToRender, transfer?: Transferable[]): void;
}

export class WasmFrame implements ChartFrame {
  constructor(
    port: Port,
    id: number,
    canvas: OffscreenCanvas,
    init: FrameInit,
    onFail: (reason: string) => void,
  ) {
    void port;
    void id;
    void canvas;
    void init;
    void onFail;
  }
  setSpec(spec: VisSpec): void {
    void spec;
  }
  setData(data: FrameData): void {
    void data;
  }
  setTimeWindow(w: TimeWindow): void {
    void w;
  }
  setTheme(t: ThemeName): void {
    void t;
  }
  setEvents(events: readonly EventMarker[]): void {
    void events;
  }
  setSelection(sel: FrameSelection | null): void {
    void sel;
  }
  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    void cssWidth;
    void cssHeight;
    void dpr;
  }
  on<E extends keyof FrameEvents>(e: E, cb: (ev: FrameEvents[E]) => void): () => void {
    void e;
    void cb;
    return () => undefined;
  }
  handle(ev: RenderEvent): void {
    void ev;
  }
  dispose(): void {
    // stub
  }
}
