/**
 * The main-thread side of one engine frame (plan #68 C1 §3.5, §4.2; ADR-0019, D-PROTO): every
 * ChartFrame call becomes one message to the render worker; the worker's events come back
 * through `handle`. Series data is cloned (the caller keeps its arrays); heatmap and scalar data
 * are not drawn by the engine yet and go as `null`. `drawn` is reported only at the size of the
 * last resize, never at 0, with its `chart-draw` measure. Events (markers) and the selection are
 * kept by the routing frame and not sent (C2). Nothing is sent or emitted after `dispose`.
 */
import type {
  ChartFrame,
  FrameData,
  FrameEvents,
  FrameInit,
  ThemeName,
  TimeWindow,
  VisSpec,
} from '../api';
import type { FrameEvent, MainToRender, SeriesMessage } from './protocol';

export interface Port {
  postMessage(msg: MainToRender, transfer?: Transferable[]): void;
}

type Listener = (ev: never) => void;

function series(data: FrameData): SeriesMessage[] | null {
  if (data.kind !== 'series') return null;
  return data.series.map((s) => ({
    key: s.key,
    names: Object.keys(s.labels),
    values: Object.values(s.labels),
    t: s.timestamps,
    v: s.values,
  }));
}

export class WasmFrame implements ChartFrame {
  private readonly listeners = new Map<keyof FrameEvents, Set<Listener>>();
  private size: readonly [number, number] = [0, 0];
  private disposed = false;
  private kind: VisSpec['kind'] = 'line';

  constructor(
    private readonly port: Port,
    readonly id: number,
    canvas: OffscreenCanvas,
    private readonly init: FrameInit,
    private readonly onFail: (reason: string) => void,
  ) {
    port.postMessage({ t: 'create', id, canvas, frameId: init.id ?? null }, [canvas]);
  }

  private post(msg: MainToRender): void {
    if (!this.disposed) this.port.postMessage(msg);
  }

  setSpec(spec: VisSpec): void {
    this.kind = spec.kind;
    this.post({ t: 'spec', id: this.id, json: JSON.stringify(spec) });
  }

  setData(data: FrameData): void {
    this.post({ t: 'data', id: this.id, series: series(data) });
  }

  setTimeWindow(w: TimeWindow): void {
    this.post({ t: 'window', id: this.id, from: w.fromMs, to: w.toMs });
  }

  setTheme(theme: ThemeName): void {
    this.post({ t: 'theme', id: this.id, theme: theme === 'light' ? 1 : 0 });
  }

  /** Kept by the routing frame; drawn from C2 on. */
  setEvents(): void {
    // Not sent until C2.
  }

  /** Kept by the routing frame; drawn from C2 on. */
  setSelection(): void {
    // Not sent until C2.
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.size = [cssWidth, cssHeight];
    this.post({ t: 'resize', id: this.id, w: cssWidth, h: cssHeight, dpr });
  }

  on<E extends keyof FrameEvents>(e: E, cb: (ev: FrameEvents[E]) => void): () => void {
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

  private emit<E extends keyof FrameEvents>(e: E, ev: FrameEvents[E]): void {
    for (const cb of [...(this.listeners.get(e) ?? [])]) (cb as (x: FrameEvents[E]) => void)(ev);
  }

  /** An event of the render worker for this frame. */
  handle(ev: FrameEvent): void {
    if (this.disposed) return;
    switch (ev.t) {
      case 'a11y':
        this.emit('a11y', ev.ev);
        return;
      case 'drawn': {
        const [w, h] = this.size;
        if (!(w > 0 && h > 0) || ev.ev.cssWidth !== w || ev.ev.cssHeight !== h) return;
        try {
          performance.measure('chart-draw', {
            start: ev.startMs,
            end: ev.endMs,
            detail: { kind: this.kind, series: ev.series, frame: this.init.id ?? null },
          });
          performance.clearMeasures('chart-draw');
        } catch {
          // The User Timing API is optional: drawing does not depend on it.
        }
        this.emit('drawn', ev.ev);
        return;
      }
      case 'failed':
        this.onFail(ev.reason);
        return;
    }
  }

  /** The worker this frame was on is gone: silent from now on, nothing posted. */
  detach(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.post({ t: 'dispose', id: this.id });
    this.disposed = true;
    this.listeners.clear();
  }
}
