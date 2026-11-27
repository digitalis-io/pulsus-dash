/**
 * The main-thread side of one engine frame (plan #68 C1 §3.5, §4.2; C2a1 §4.4; C2a2 §3.2, §3.3;
 * ADR-0019, ADR-0030, D-PROTO). Spec, data and theme are messages to the render worker; the camera
 * and the size are input ring records (`ring.ts`), held until the worker reports the frame
 * `created` and then enqueued in the order of their calls; the worker's events come back through
 * `handle`. The camera comes only from `setCamera`: `ControlledFrame` runs the camera controller
 * on the main thread and sends it. Series data is cloned (the caller keeps its arrays); heatmap and
 * scalar data are not drawn by the engine yet and go as `null`. Event markers go as their times
 * (`events`, plan #68 C2c1), the selection as its keys and interval (`selection`, C2c2).
 * Nothing is sent or emitted after `dispose`.
 *
 * | Call or event | Behaviour |
 * |---|---|
 * | `setCamera(c)` | a Camera record (view, value: null = auto, band: null = measured) |
 * | `setSpec(s)` | a message |
 * | `setEvents(e)` (C2c1) | an `events` message of every `atMs`, for an array new by identity |
 * | `setSelection(s)` (C2c2) | a `selection` message of its keys and interval, unless equal to the last one posted |
 * | `stage` | `stage()` is the last completed presentation's: only an event of the latest `resize()` call counts (none while a Resize is held or unpublished, and only for that call's seq); every `resize()` blocks it until then; a zero size makes it null at once. `onStage` on every change |
 * | Camera, Resize before `created` | held, the latest per kind; on `created` enqueued in call order |
 * | `drawn` | only for the latest `resize()` call: none while a Resize is held or unpublished, and only when the event's `rseq` is that call's seq; reported with the caller's values, never at 0, with its `chart-draw` measure and a `chart-present` mark (C2d1) |
 * | `applied`, `drawn` seqs | extended to 53 bits against the frame's last published seq: the acks `settled()` compares |
 * | `setOverlay(o)` (C2b) | an Overlay record (the hover and the box band); before `created` held, the latest |
 * | `select(x, y)` (C2b) | a Select record; before `created` dropped (no stage can exist yet) |
 * | `hover` (C2b) | only for the latest Overlay: none while one is held or unpublished, and only when the event's `oseq` extends to the last published Overlay's seq |
 * | `select` (C2b) | forwarded as `{source: 'pointer', item}`: it answers what was on screen |
 */
import type {
  EventMarker,
  FrameData,
  FrameEvents,
  FrameInit,
  FrameSelection,
  PlotRect,
  ThemeName,
  ValueRange,
  VisSpec,
} from '../api';
import { REC_OVERLAY, REC_RESIZE } from './layout.gen';
import type { FrameEvent, MainToRender, SeriesMessage, StageWire } from './protocol';
import { extendSeq } from './ring';

/** The engine camera a Camera record carries: null value = auto, null band = measured. */
export interface CameraState {
  readonly view: { readonly lo: number; readonly hi: number };
  readonly value: ValueRange | null;
  readonly band: number | null;
}

/**
 * The geometry of the frame on screen, as the camera controller reads it (mirrors
 * `controller/stage.ts`; this directory imports only `../api`, T03-001).
 */
export interface StageModel {
  readonly plot: PlotRect;
  readonly valueDomain: ValueRange | null;
  readonly labelW: number;
  readonly pickCount: number;
}

/** What an Overlay record carries (plan #68 C2b §3.4): the hover and the box band, CSS px. */
export interface OverlayState {
  readonly hover:
    | { readonly kind: 'none' }
    | { readonly kind: 'pointer'; readonly x: number; readonly y: number }
    | { readonly kind: 'key'; readonly index: number };
  readonly box: { readonly x0: number; readonly x: number } | null;
}

/** An engine frame (plan #68 C2a2 §3.2): `ControlledFrame` drives its camera. */
export interface EngineFrame {
  setSpec(s: VisSpec): void;
  setData(d: FrameData): void;
  setTheme(t: ThemeName): void;
  setEvents(e: readonly EventMarker[]): void;
  setSelection(s: FrameSelection | null): void;
  resize(cssW: number, cssH: number, dpr: number): void;
  setCamera(c: CameraState): void;
  /** The hover and the box band (plan #68 C2b §4.2). */
  setOverlay(o: OverlayState): void;
  /** A click at CSS px (x, y): answered with `select` against the presentation on screen. */
  select(x: number, y: number): void;
  /** The last completed presentation's stage; null before the first, when withdrawn, at size 0. */
  stage(): StageModel | null;
  /** Called on every change of `stage()`; returns the unsubscribe. */
  onStage(cb: (s: StageModel | null) => void): () => void;
  on<E extends 'a11y' | 'drawn' | 'hover' | 'select'>(
    e: E,
    cb: (ev: FrameEvents[E]) => void,
  ): () => void;
  dispose(): void;
}

/** What a frame needs of the input ring (`ring.ts`). */
export interface FrameRing {
  camera(frame: number, c: CameraState): void;
  resize(frame: number, cssW: number, cssH: number, dpr: number): void;
  overlay(frame: number, o: OverlayState): void;
  select(frame: number, x: number, y: number): void;
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

const sameStage = (a: StageModel | null, b: StageModel | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.plot.x === b.plot.x &&
    a.plot.y === b.plot.y &&
    a.plot.width === b.plot.width &&
    a.plot.height === b.plot.height &&
    a.labelW === b.labelW &&
    a.pickCount === b.pickCount &&
    (a.valueDomain === b.valueDomain ||
      (a.valueDomain !== null &&
        b.valueDomain !== null &&
        a.valueDomain.min === b.valueDomain.min &&
        a.valueDomain.max === b.valueDomain.max)));

/** The controller's view of a reported stage. */
const stageOf = (w: StageWire | null): StageModel | null =>
  w === null
    ? null
    : { plot: w.plot, valueDomain: w.domain, labelW: w.labelW, pickCount: w.pickCount };

/** Resize seqs kept for `drawn`. */
const KEEP_RESIZES = 8;

type Size = readonly [number, number, number];

/**
 * Equal keys (in order) and interval; null equals only null: `canvas2d/gesture.ts`
 * `sameSelection`'s rule (T03-001 keeps this module apart from the Canvas 2D engine).
 */
function sameSelection(a: FrameSelection | null, b: FrameSelection | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return (
    a.fromMs === b.fromMs &&
    a.toMs === b.toMs &&
    a.keys.length === b.keys.length &&
    a.keys.every((k, i) => k === b.keys[i])
  );
}

export class WasmFrame implements EngineFrame {
  private readonly listeners = new Map<keyof FrameEvents, Set<Listener>>();
  private disposed = false;
  private kind: VisSpec['kind'] = 'line';
  /** The last `setEvents` array (plan #68 C2c1 §3.3): a new array is sent, the same one is not. */
  private events: readonly EventMarker[] | null = null;
  /** The last selection posted (plan #68 C2c2 §3.1); `undefined` before the first call. */
  private selection: FrameSelection | null | undefined = undefined;
  /** The last completed presentation's stage, and its listeners (plan #68 C2a2 §3.3). */
  private stageNow: StageModel | null = null;
  private readonly stageCbs = new Set<(s: StageModel | null) => void>();
  /** Set by every `resize()` call; cleared by a `stage` or `drawn` of that call's seq. */
  private stageBlocked = false;
  private ring: FrameRing | null = null;
  /** Before `created`: the latest Camera, Resize and Overlay, in the order of their last call. */
  private readonly held = new Map<'camera' | 'resize' | 'overlay', (r: FrameRing) => void>();
  /** The last published Overlay's seq (53-bit), and whether a later one is still unpublished. */
  private lastOseq = 0;
  private overlayUnpublished = false;
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
  private record(kind: 'camera' | 'resize' | 'overlay', go: (r: FrameRing) => void): void {
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
    this.post({ t: 'spec', id: this.id, json: JSON.stringify(spec) });
  }

  setData(data: FrameData): void {
    this.post({ t: 'data', id: this.id, series: series(data) });
  }

  setCamera(c: CameraState): void {
    this.record('camera', (r) => {
      r.camera(this.id, c);
    });
  }

  setTheme(theme: ThemeName): void {
    this.post({ t: 'theme', id: this.id, theme: theme === 'light' ? 1 : 0 });
  }

  /** The hover and the box band (plan #68 C2b §4.2): an Overlay record, held before `created`. */
  setOverlay(o: OverlayState): void {
    this.record('overlay', (r) => {
      this.overlayUnpublished = true;
      r.overlay(this.id, o);
    });
  }

  /** A click: a Select record; dropped before `created`, when no stage can exist yet. */
  select(x: number, y: number): void {
    if (this.disposed || this.ring === null) return;
    this.ring.select(this.id, x, y);
  }

  /**
   * The event markers (plan #68 C2c1 §3.3): an `events` message with every `atMs`, in call order
   * (NaN kept), for each array that differs by identity from the last one.
   */
  setEvents(events: readonly EventMarker[]): void {
    if (this.disposed || events === this.events) return;
    this.events = events;
    this.post({ t: 'events', id: this.id, atMs: Float64Array.from(events, (e) => e.atMs) });
  }

  /** Kept by the routing frame; drawn from C2 on. */
  /**
   * The page selection (plan #68 C2c2 §3.1): a `selection` message of its keys and interval
   * (`null`: no keys, no interval), unless equal to the last one posted; the first call always
   * posts.
   */
  setSelection(sel: FrameSelection | null): void {
    if (this.disposed) return;
    if (this.selection !== undefined && sameSelection(this.selection, sel)) return;
    this.selection =
      sel === null ? null : { keys: [...sel.keys], fromMs: sel.fromMs, toMs: sel.toMs };
    this.post({
      t: 'selection',
      id: this.id,
      keys: sel === null ? [] : [...sel.keys],
      fromMs: sel?.fromMs ?? null,
      toMs: sel?.toMs ?? null,
    });
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    if (this.disposed) return;
    const size: Size = [cssWidth, cssHeight, dpr];
    this.size = size;
    // The stage on screen is not this size's until its presentation reports (plan #68 C2a2 §3.3);
    // the worker draws nothing at a zero size, so the stage goes at once.
    this.stageBlocked = true;
    if (!(cssWidth > 0 && cssHeight > 0)) this.setStage(null);
    this.record('resize', (r) => {
      this.resizeUnpublished = true;
      r.resize(this.id, size[0], size[1], size[2]);
    });
  }

  stage(): StageModel | null {
    return this.stageNow;
  }

  onStage(cb: (s: StageModel | null) => void): () => void {
    if (this.disposed) return () => undefined;
    this.stageCbs.add(cb);
    return () => {
      this.stageCbs.delete(cb);
    };
  }

  private setStage(s: StageModel | null): void {
    if (sameStage(s, this.stageNow)) return;
    this.stageNow = s;
    for (const cb of [...this.stageCbs]) cb(s);
  }

  /** An event of presentation `rseq` is of the latest `resize()` call (and unblocks the stage). */
  private current(rseq: number): boolean {
    if (this.held.has('resize') || this.resizeUnpublished) return false;
    if (extendSeq(this.lastSeq, rseq) !== this.lastRseq) return false;
    this.stageBlocked = false;
    return true;
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
    if (kind === REC_OVERLAY) {
      this.lastOseq = seq;
      this.overlayUnpublished = false;
      return;
    }
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

  /** The highest presentation seq reported `drawn` (53-bit; the probe's `frozen`). */
  drawnSeqNow(): number {
    return this.drawnSeq;
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
      case 'hover':
        // Only the latest Overlay's hover counts (plan #68 C2b §4.2).
        if (this.held.has('overlay') || this.overlayUnpublished) return;
        if (extendSeq(this.lastSeq, ev.oseq) !== this.lastOseq) return;
        this.emit('hover', ev.ev);
        return;
      case 'select':
        this.emit('select', { source: 'pointer', item: ev.item });
        return;
      case 'stage':
        if (!this.current(ev.rseq)) return;
        this.setStage(stageOf(ev.stage));
        return;
      case 'drawn': {
        this.drawnSeq = Math.max(this.drawnSeq, extendSeq(this.lastSeq, ev.seq));
        if (!this.current(ev.rseq)) return;
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
          // The presented frame, where `drawn` is emitted (the frame benches, plan #68 C2d1 §1).
          performance.mark('chart-present', { detail: { frame: this.init.id ?? null } });
          performance.clearMarks('chart-present');
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
    this.stageCbs.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.ring?.drop(this.id);
    this.held.clear();
    this.post({ t: 'dispose', id: this.id });
    this.disposed = true;
    this.listeners.clear();
    this.stageCbs.clear();
  }
}
