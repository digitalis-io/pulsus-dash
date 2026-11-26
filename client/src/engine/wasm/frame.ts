/**
 * The main-thread side of one engine frame (plan #68 C1 §3.5, §4.2; C2a1 §4.4; ADR-0019,
 * D-PROTO). Spec, data and theme are messages to the render worker; the camera and the size are
 * input ring records (`ring.ts`), held until the worker reports the frame `created` and then
 * enqueued in the order of their calls; the worker's events come back through `handle`. Series
 * data is cloned (the caller keeps its arrays); heatmap and scalar data are not drawn by the engine
 * yet and go as `null`. Events (markers) and the selection are kept by the routing frame and not
 * sent (C2). Nothing is sent or emitted after `dispose`.
 *
 * | Call or event | Behaviour |
 * |---|---|
 * | `setTimeWindow(w)` | the idle camera: view = the window, value = the spec's valid line `valueRange` (else auto), band measured |
 * | `setSpec(s)` | a message; with a window, the idle camera again |
 * | Camera, Resize before `created` | held, the latest per kind; on `created` enqueued in call order |
 * | `drawn` | only for the latest `resize()` call: none while a Resize is held or unpublished, and only when the event's `rseq` is that call's seq; reported with the caller's values, never at 0, with its `chart-draw` measure |
 * | `applied`, `drawn` seqs | extended to 53 bits against the frame's last published seq: the acks `settled()` compares |
 */
import type {
  ChartFrame,
  FrameData,
  FrameEvents,
  FrameInit,
  ThemeName,
  TimeWindow,
  ValueRange,
  VisSpec,
} from '../api';
import { REC_RESIZE } from './layout.gen';
import type { FrameEvent, MainToRender, SeriesMessage } from './protocol';
import { extendSeq } from './ring';

/** The engine camera a Camera record carries: null value = auto, null band = measured. */
export interface CameraState {
  readonly view: { readonly lo: number; readonly hi: number };
  readonly value: ValueRange | null;
  readonly band: number | null;
}

/** What a frame needs of the input ring (`ring.ts`). */
export interface FrameRing {
  camera(frame: number, c: CameraState): void;
  resize(frame: number, cssW: number, cssH: number, dpr: number): void;
  onPublish(frame: number, cb: (kind: number, seq: number) => void): void;
  unpublished(frame: number): number;
  drop(frame: number): void;
}

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

/** A line spec's `valueRange` when it is finite with min < max: the idle camera's value. */
function pin(spec: VisSpec | null): ValueRange | null {
  if (spec?.kind !== 'line' || spec.valueRange === undefined) return null;
  const { min, max } = spec.valueRange;
  return Number.isFinite(min) && Number.isFinite(max) && min < max ? { min, max } : null;
}

/** Resize seqs kept for `drawn`. */
const KEEP_RESIZES = 8;

type Size = readonly [number, number, number];

export class WasmFrame implements ChartFrame {
  private readonly listeners = new Map<keyof FrameEvents, Set<Listener>>();
  private disposed = false;
  private kind: VisSpec['kind'] = 'line';
  private spec: VisSpec | null = null;
  private window: TimeWindow | null = null;
  private ring: FrameRing | null = null;
  /** Before `created`: the latest Camera and Resize, in the order of their last call. */
  private readonly held = new Map<'camera' | 'resize', (r: FrameRing) => void>();
  /** The latest `resize()` call, and whether its record is still unpublished. */
  private size: Size = [0, 0, 1];
  private resizeUnpublished = false;
  /** Published Resize seqs → the call they carry (the last 8). */
  private readonly resizes = new Map<number, Size>();
  /** The 53-bit seqs: the last Resize and the last record published; the two acks. */
  private lastRseq = 0;
  private lastSeq = 0;
  private applied = 0;
  private drawnSeq = 0;

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

  /** A record now if the frame is created, else held (replacing the kind's earlier one). */
  private record(kind: 'camera' | 'resize', go: (r: FrameRing) => void): void {
    if (this.disposed) return;
    if (this.ring !== null) {
      go(this.ring);
      return;
    }
    this.held.delete(kind);
    this.held.set(kind, go);
  }

  setSpec(spec: VisSpec): void {
    this.kind = spec.kind;
    this.spec = spec;
    this.post({ t: 'spec', id: this.id, json: JSON.stringify(spec) });
    if (this.window !== null) this.setTimeWindow(this.window);
  }

  setData(data: FrameData): void {
    this.post({ t: 'data', id: this.id, series: series(data) });
  }

  /** The idle camera of the window (#93 §3.4; C2a2 moves it to the camera controller). */
  setTimeWindow(w: TimeWindow): void {
    this.window = w;
    this.setCamera({ view: { lo: w.fromMs, hi: w.toMs }, value: pin(this.spec), band: null });
  }

  setCamera(c: CameraState): void {
    this.record('camera', (r) => {
      r.camera(this.id, c);
    });
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
    if (this.disposed) return;
    const size: Size = [cssWidth, cssHeight, dpr];
    this.size = size;
    this.record('resize', (r) => {
      this.resizeUnpublished = true;
      r.resize(this.id, size[0], size[1], size[2]);
    });
  }

  /** The worker created the frame: its held records go to the ring, in call order. */
  created(ring: FrameRing): void {
    if (this.disposed || this.ring !== null) return;
    this.ring = ring;
    ring.onPublish(this.id, (kind, seq) => {
      this.published(kind, seq);
    });
    const held = [...this.held.values()];
    this.held.clear();
    for (const go of held) go(ring);
  }

  private published(kind: number, seq: number): void {
    this.lastSeq = seq;
    if (kind !== REC_RESIZE) return;
    // A published Resize is always the latest call: an unpublished one is replaced by later calls.
    this.resizeUnpublished = false;
    this.lastRseq = seq;
    this.resizes.set(seq, this.size);
    for (const k of this.resizes.keys()) {
      if (this.resizes.size <= KEEP_RESIZES) break;
      this.resizes.delete(k);
    }
  }

  /**
   * Nothing held or unpublished, every published record applied and, at a non-zero size, the last
   * one presented (`__dashProbe.settle`, plan #68 C2a1 §3.4).
   */
  settled(): boolean {
    if (this.held.size > 0 || (this.ring?.unpublished(this.id) ?? 0) > 0) return false;
    if (this.applied < this.lastSeq) return false;
    const [w, h] = this.size;
    return !(w > 0 && h > 0) || this.drawnSeq >= this.lastSeq;
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
      case 'applied':
        this.applied = Math.max(this.applied, extendSeq(this.lastSeq, ev.seq));
        return;
      case 'created':
        return;
      case 'drawn': {
        this.drawnSeq = Math.max(this.drawnSeq, extendSeq(this.lastSeq, ev.seq));
        if (this.held.has('resize') || this.resizeUnpublished) return;
        if (extendSeq(this.lastSeq, ev.rseq) !== this.lastRseq) return;
        const size = this.resizes.get(this.lastRseq);
        if (size === undefined) return;
        const [w, h, dpr] = size;
        if (!(w > 0 && h > 0)) return;
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
        this.emit('drawn', { cssWidth: w, cssHeight: h, dpr });
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
    this.held.clear();
    this.listeners.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.ring?.drop(this.id);
    this.held.clear();
    this.post({ t: 'dispose', id: this.id });
    this.disposed = true;
    this.listeners.clear();
  }
}
