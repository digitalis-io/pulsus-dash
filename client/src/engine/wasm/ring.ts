/**
 * The input ring's producer (plan #68 C2a1 §3.1, §3.3, §4.1; T03 §5.4, T03-004 revised, T03-006,
 * T03-020): the main thread writes Resize, Camera, Overlay and Select records (the last two from
 * plan #68 C2b §3.1) into the control block's ring and the render worker reads them at the start
 * of its next tick. One ring per engine memory (each status
 * gets a new one).
 *
 * | Step | Behaviour |
 * |---|---|
 * | counters | free-running `u32` byte counts: occupied = `(head − tail) >>> 0`; the physical offset = `head & (RING − 1)`; loads `>>> 0`, stores `\| 0` |
 * | publish | the size, plus the gap to the end when the record would cross it (a Wrap byte there); too little free → pending; else the payload (`DataView`, little-endian), then `Atomics.store(HEAD)` |
 * | pending | `Map<'kind:frame'>`, no seqs; a replacement deletes, then inserts (to the end): `coalesced`. A Select is discrete: its key is unique, so it is never coalesced; a frame keeps at most 8 waiting, a 9th drops the oldest (`INPUT_OVERFLOW` + 1, one warning per frame) |
 * | order | up to 32 pending are published before a new record; if any remain it joins them; an animation frame publishes up to 256 |
 * | seq | per frame from `firstSeq` (1), assigned at publish; the wire carries `P mod 2³²`, a `P ≡ 0` is skipped; `onPublish` gets `P` (53-bit) |
 * | wake | after each publish `Atomics.compareExchange(IDLE, 1, 0) === 1` → `wake()`: at most one per idle period |
 *
 * Nothing else is dropped: a state record that does not fit waits (only the latest per kind and
 * frame is kept).
 */
import type { CameraState, OverlayState } from './frame';
import {
  CAMERA_BAND,
  CAMERA_FRAME,
  CAMERA_VALUE_MAX,
  CAMERA_VALUE_MIN,
  CAMERA_VIEW_HI,
  CAMERA_VIEW_LO,
  CB_BYTES,
  OFF_INPUT_DATA,
  OFF_INPUT_HEAD,
  OFF_INPUT_IDLE,
  OFF_INPUT_OVERFLOW,
  OFF_INPUT_TAIL,
  OVERLAY_BOX,
  OVERLAY_BOX_X,
  OVERLAY_BOX_X0,
  OVERLAY_FRAME,
  OVERLAY_HOVER,
  OVERLAY_KEY,
  OVERLAY_X,
  OVERLAY_Y,
  REC_CAMERA,
  REC_CAMERA_BYTES,
  REC_OVERLAY,
  REC_OVERLAY_BYTES,
  REC_RESIZE,
  REC_RESIZE_BYTES,
  REC_SELECT,
  REC_SELECT_BYTES,
  REC_WRAP,
  RESIZE_CSS_H,
  RESIZE_CSS_W,
  RESIZE_DEVICE_H,
  RESIZE_DEVICE_W,
  RESIZE_DPR,
  RESIZE_FRAME,
  RING_BYTES,
  SELECT_FRAME,
  SELECT_X,
  SELECT_Y,
} from './layout.gen';

/** One record as the probe logs it (and `engine_probe_input` decodes it). */
export interface InputRec {
  readonly seq: number;
  readonly kind: number;
  readonly frame: number;
  readonly tMs: number;
  /** The payload in table order; `f32`s through `Math.fround`, NaN as null. */
  readonly f: readonly (number | null)[];
}

export interface RingOptions {
  /** The first seq of every frame (tests). */
  readonly firstSeq?: number;
  /** Keep `produced` (the probe build). */
  readonly log?: boolean;
  /** The enqueue time (tests and fixtures); `performance.now()`. */
  readonly now?: () => number;
}

/** The largest value ≤ `p` congruent to the u32 ack `a` (valid while the lag is < 2³²). */
export const extendSeq = (p: number, a: number): number =>
  p - ((((p - a) % 2 ** 32) + 2 ** 32) % 2 ** 32);

/** Pending records published before a new one, and per animation frame. */
const BEFORE_OWN = 32;
const PER_FLUSH = 256;
/** The probe log's bound (as the worker's). */
const MAX_LOG = 20_000;
/** Waiting Selects kept per frame (plan #68 C2b §3.1). */
const MAX_SELECTS = 8;

interface Rec {
  readonly kind: number;
  readonly frame: number;
  readonly size: number;
  readonly tMs: number;
  /** Writes the payload at `at` (header excluded). */
  readonly write: (d: DataView, at: number) => void;
  readonly f: readonly (number | null)[];
  /** Discrete (Select): never coalesced, capped per frame. */
  readonly discrete?: true;
}

const nul = (v: number): number | null => (Number.isNaN(v) ? null : v);

/** The ST input batch (plan #68 C2d2 §3.2): 64 KiB, as the ring. */
export const BATCH_BYTES = RING_BYTES;

/** What a frame and the engine host need of either sink (plan #68 C2d2 §3.2). */
export interface FrameRing {
  camera(frame: number, c: CameraState): void;
  resize(frame: number, cssW: number, cssH: number, dpr: number): void;
  overlay(frame: number, o: OverlayState): void;
  select(frame: number, x: number, y: number): void;
  onPublish(frame: number, cb: (kind: number, seq: number) => void): void;
  unpublished(frame: number): number;
  drop(frame: number): void;
  flush(): void;
  close(): void;
  readonly stats: RingStats;
  readonly produced: InputRec[] | null;
}

/** `selects`: Select records taken (published, pending or dropped by the cap; plan #68 C2b). */
export interface RingStats {
  coalesced: number;
  publishedBytes: number;
  selects: number;
}

/**
 * The record queue shared by both sinks (plan #68 C2d2 §3.2): the record builders, the pending map
 * (coalescing per `kind:frame`, Selects unique and capped at 8 per frame), the per-frame seqs
 * assigned at publish, the listeners and the probe log. The sink decides when a record goes out.
 */
abstract class RecordQueue {
  readonly stats: RingStats = { coalesced: 0, publishedBytes: 0, selects: 0 };
  /** Every published record, in order (`log` only). */
  produced: InputRec[] | null;
  protected readonly pending = new Map<string, Rec>();
  private readonly seqs = new Map<number, number>();
  private readonly listeners = new Map<number, (kind: number, seq: number) => void>();
  private readonly now: () => number;
  private readonly firstSeq: number;
  /** Select keys are unique: `select:frame:n`. */
  private nextSelect = 0;
  /** Frames already warned about a dropped Select. */
  private readonly warned = new Set<number>();
  private scheduled = false;
  protected closed = false;

  constructor(o: RingOptions) {
    this.now = o.now ?? (() => performance.now());
    this.firstSeq = o.firstSeq ?? 1;
    this.produced = o.log === true ? [] : null;
  }

  camera(frame: number, c: CameraState): void {
    const v = [
      c.view.lo,
      c.view.hi,
      c.value?.min ?? NaN,
      c.value?.max ?? NaN,
      c.band ?? NaN,
    ] as const;
    this.enqueue({
      kind: REC_CAMERA,
      frame,
      size: REC_CAMERA_BYTES,
      tMs: this.now(),
      write: (d, at) => {
        d.setUint32(at + CAMERA_FRAME, frame, true);
        d.setUint32(at + CAMERA_FRAME + 4, 0, true);
        d.setFloat64(at + CAMERA_VIEW_LO, v[0], true);
        d.setFloat64(at + CAMERA_VIEW_HI, v[1], true);
        d.setFloat64(at + CAMERA_VALUE_MIN, v[2], true);
        d.setFloat64(at + CAMERA_VALUE_MAX, v[3], true);
        d.setFloat64(at + CAMERA_BAND, v[4], true);
      },
      f: [frame, ...v.map(nul)],
    });
  }

  /** CSS px and DPR; device px = `round(css × dpr)`. */
  resize(frame: number, cssW: number, cssH: number, dpr: number): void {
    const dw = Math.max(0, Math.round(cssW * dpr)) >>> 0;
    const dh = Math.max(0, Math.round(cssH * dpr)) >>> 0;
    this.enqueue({
      kind: REC_RESIZE,
      frame,
      size: REC_RESIZE_BYTES,
      tMs: this.now(),
      write: (d, at) => {
        d.setFloat32(at + RESIZE_CSS_W, cssW, true);
        d.setFloat32(at + RESIZE_CSS_H, cssH, true);
        d.setFloat32(at + RESIZE_DPR, dpr, true);
        d.setUint32(at + RESIZE_DEVICE_W, dw, true);
        d.setUint32(at + RESIZE_DEVICE_H, dh, true);
        d.setUint32(at + RESIZE_FRAME, frame, true);
      },
      f: [nul(Math.fround(cssW)), nul(Math.fround(cssH)), nul(Math.fround(dpr)), dw, dh, frame],
    });
  }

  /** The hover and the box band (plan #68 C2b §3.1): coalesced per frame like a Camera. */
  overlay(frame: number, o: OverlayState): void {
    const h = o.hover;
    const mode = h.kind === 'none' ? 0 : h.kind === 'pointer' ? 1 : 2;
    const x = h.kind === 'pointer' ? h.x : 0;
    const y = h.kind === 'pointer' ? h.y : 0;
    const key = h.kind === 'key' ? h.index >>> 0 : 0;
    const boxed = o.box === null ? 0 : 1;
    const x0 = o.box?.x0 ?? 0;
    const x1 = o.box?.x ?? 0;
    this.enqueue({
      kind: REC_OVERLAY,
      frame,
      size: REC_OVERLAY_BYTES,
      tMs: this.now(),
      write: (d, at) => {
        d.setUint32(at + OVERLAY_FRAME, frame, true);
        d.setUint8(at + OVERLAY_HOVER, mode);
        d.setUint8(at + OVERLAY_BOX, boxed);
        d.setUint16(at + OVERLAY_BOX + 1, 0, true);
        d.setFloat64(at + OVERLAY_X, x, true);
        d.setFloat64(at + OVERLAY_Y, y, true);
        d.setUint32(at + OVERLAY_KEY, key, true);
        d.setUint32(at + OVERLAY_KEY + 4, 0, true);
        d.setFloat64(at + OVERLAY_BOX_X0, x0, true);
        d.setFloat64(at + OVERLAY_BOX_X, x1, true);
      },
      f: [frame, mode, boxed, nul(x), nul(y), key, nul(x0), nul(x1)],
    });
  }

  /** A click at CSS px (plan #68 C2b §3.1): discrete, never coalesced, ≤ 8 waiting per frame. */
  select(frame: number, x: number, y: number): void {
    this.stats.selects += 1;
    this.enqueue(
      {
        kind: REC_SELECT,
        frame,
        size: REC_SELECT_BYTES,
        tMs: this.now(),
        write: (d, at) => {
          d.setUint32(at + SELECT_FRAME, frame, true);
          d.setUint32(at + SELECT_FRAME + 4, 0, true);
          d.setFloat64(at + SELECT_X, x, true);
          d.setFloat64(at + SELECT_Y, y, true);
        },
        f: [frame, nul(x), nul(y)],
        discrete: true,
      },
      `select:${String(frame)}:${String(this.nextSelect++)}`,
    );
  }

  /** `cb(kind, P)` after each of the frame's records is published. */
  onPublish(frame: number, cb: (kind: number, seq: number) => void): void {
    this.listeners.set(frame, cb);
  }

  /** The frame's records not yet published. */
  unpublished(frame: number): number {
    let n = 0;
    for (const r of this.pending.values()) if (r.frame === frame) n++;
    return n;
  }

  /** Forgets the frame: its pending records and its listener (dispose). */
  drop(frame: number): void {
    for (const [k, r] of this.pending) if (r.frame === frame) this.pending.delete(k);
    this.listeners.delete(frame);
  }

  /** The engine this sink writes to is gone (a restart, a fatal failure): nothing more. */
  close(): void {
    this.closed = true;
    this.pending.clear();
    this.listeners.clear();
  }

  /** Publishes what the sink can (each animation frame while any are pending). */
  abstract flush(): void;

  protected abstract enqueue(r: Rec, key?: string): void;

  /** One Select of `frame` dropped by the cap (`INPUT_OVERFLOW`, or `stats.overflow` in ST). */
  protected abstract countOverflow(): void;

  /** Room for one more waiting Select of `frame`: past 8 the oldest goes, counted and warned. */
  protected capSelects(frame: number): void {
    let n = 0;
    let oldest: string | null = null;
    for (const [k, r] of this.pending) {
      if (r.kind !== REC_SELECT || r.frame !== frame) continue;
      oldest ??= k;
      n++;
    }
    if (n < MAX_SELECTS || oldest === null) return;
    this.pending.delete(oldest);
    this.countOverflow();
    if (!this.warned.has(frame)) {
      this.warned.add(frame);
      console.warn(`pulsus engine: frame ${String(frame)} dropped a click (ring full)`);
    }
  }

  /** Writes `r`'s header and payload at `at` with the frame's next seq; returns that seq (`P`). */
  protected write(d: DataView, at: number, r: Rec): number {
    let p = (this.seqs.get(r.frame) ?? this.firstSeq - 1) + 1;
    if (p % 2 ** 32 === 0) p += 1;
    this.seqs.set(r.frame, p);
    d.setUint8(at, r.kind);
    d.setUint8(at + 1, 0);
    d.setUint16(at + 2, r.size, true);
    d.setUint32(at + 4, p >>> 0, true);
    d.setFloat64(at + 8, r.tMs, true);
    r.write(d, at);
    return p;
  }

  /** After a record of `bytes` is out: the stats, the probe log and the frame's listener. */
  protected published(r: Rec, p: number, bytes: number): void {
    this.stats.publishedBytes += bytes;
    if (this.produced !== null && this.produced.length < MAX_LOG) {
      this.produced.push({ seq: p >>> 0, kind: r.kind, frame: r.frame, tMs: r.tMs, f: r.f });
    }
    this.listeners.get(r.frame)?.(r.kind, p);
  }

  protected schedule(raf = defaultRaf): void {
    if (this.scheduled || this.closed || this.pending.size === 0) return;
    this.scheduled = true;
    raf(() => {
      this.scheduled = false;
      this.flush();
    });
  }
}

/** The page's animation frame, or 16 ms without one. */
function defaultRaf(cb: () => void): void {
  const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => number })
    .requestAnimationFrame;
  if (typeof raf === 'function') raf.call(globalThis, cb);
  else setTimeout(cb, 16);
}

/** The shared-memory sink (MT): records go straight into the control block's ring. */
export class InputRing extends RecordQueue implements FrameRing {
  private readonly i32: Int32Array;
  private readonly data: DataView;
  private head: number;
  private readonly wake: () => void;

  constructor(memory: WebAssembly.Memory, cb: number, wake: () => void, o: RingOptions = {}) {
    super(o);
    this.wake = wake;
    this.i32 = new Int32Array(memory.buffer, cb, CB_BYTES / 4);
    this.data = new DataView(memory.buffer, cb + OFF_INPUT_DATA, RING_BYTES);
    this.head = this.load(OFF_INPUT_HEAD);
  }

  private load(off: number): number {
    return Atomics.load(this.i32, off / 4) >>> 0;
  }

  /** Publishes up to 256 pending records (each animation frame while any are pending). */
  flush(): void {
    this.publishPending(PER_FLUSH);
    this.schedule();
  }

  protected enqueue(r: Rec, key = `${String(r.kind)}:${String(r.frame)}`): void {
    if (this.closed) return;
    if (r.discrete !== true && this.pending.delete(key)) {
      this.stats.coalesced += 1;
      this.pending.set(key, r);
      return;
    }
    this.publishPending(BEFORE_OWN);
    if (this.pending.size > 0 || !this.publish(r)) {
      if (r.discrete === true) this.capSelects(r.frame);
      this.pending.set(key, r);
    }
    this.schedule();
  }

  protected countOverflow(): void {
    Atomics.add(this.i32, OFF_INPUT_OVERFLOW / 4, 1);
  }

  private publishPending(max: number): void {
    let n = 0;
    for (const [k, r] of this.pending) {
      if (n >= max || !this.publish(r)) return;
      this.pending.delete(k);
      n++;
    }
  }

  /** Writes `r` and publishes it; false when it does not fit. */
  private publish(r: Rec): boolean {
    const tail = this.load(OFF_INPUT_TAIL);
    const free = RING_BYTES - ((this.head - tail) >>> 0);
    let at = this.head & (RING_BYTES - 1);
    const gap = at + r.size > RING_BYTES ? RING_BYTES - at : 0;
    if (free < r.size + gap) return false;
    const d = this.data;
    if (gap > 0) {
      d.setUint8(at, REC_WRAP);
      d.setUint8(at + 1, 0);
      d.setUint16(at + 2, gap, true);
      at = 0;
    }
    const p = this.write(d, at, r);
    this.head = (this.head + gap + r.size) >>> 0;
    Atomics.store(this.i32, OFF_INPUT_HEAD / 4, this.head | 0);
    this.published(r, p, gap + r.size);
    if (Atomics.compareExchange(this.i32, OFF_INPUT_IDLE / 4, 1, 0) === 1) this.wake();
    return true;
  }
}

export interface BatchOptions extends RingOptions {
  /** The animation frame (tests); the page's `requestAnimationFrame`. */
  readonly raf?: (cb: () => void) => void;
}

/** `BatchRing.stats` (plan #68 C2d2 §3.2, the probe's `stats()`). */
export interface BatchStats extends RingStats {
  /** Selects dropped by the per-frame cap (`INPUT_OVERFLOW` in MT). */
  overflow: number;
  /** Batches posted. */
  batches: number;
  /** The most batches in flight at once, end to end (main's count, or a worker's `depth`). */
  batchesInFlightMax: number;
}

/**
 * The single-thread sink (plan #68 C2d2 §3.2): ST has no shared memory, so every call goes to
 * pending, and on main's animation frame, if no batch is in flight, up to 64 KiB of pending records
 * are copied in order into a transferable batch (each gets its seq there and `onPublish` fires),
 * which is posted. Two buffers alternate, and exactly one batch may be in flight: the next is
 * posted only after the worker's `input-ack` returns the buffer (`acked`), which it sends after the
 * tick that applied the batch. The record bytes are `InputRing`'s.
 */
export class BatchRing extends RecordQueue implements FrameRing {
  override readonly stats: BatchStats = {
    coalesced: 0,
    publishedBytes: 0,
    selects: 0,
    overflow: 0,
    batches: 0,
    batchesInFlightMax: 0,
  };
  private readonly post: (buf: ArrayBuffer, len: number) => void;
  private readonly raf: (cb: () => void) => void;
  private readonly free: ArrayBuffer[] = [
    new ArrayBuffer(BATCH_BYTES),
    new ArrayBuffer(BATCH_BYTES),
  ];
  private inFlight = 0;

  constructor(post: (buf: ArrayBuffer, len: number) => void, o: BatchOptions = {}) {
    super(o);
    this.post = post;
    this.raf = o.raf ?? defaultRaf;
  }

  /** On the animation frame: one batch of pending records, unless one is in flight. */
  flush(): void {
    if (this.closed || this.inFlight > 0) return;
    const buf = this.free.shift();
    if (buf === undefined) return;
    const d = new DataView(buf);
    let len = 0;
    for (const [k, r] of this.pending) {
      if (len + r.size > BATCH_BYTES) break;
      const p = this.write(d, len, r);
      len += r.size;
      this.pending.delete(k);
      this.published(r, p, r.size);
    }
    if (len === 0) {
      this.free.push(buf);
      return;
    }
    this.inFlight += 1;
    this.stats.batches += 1;
    this.stats.batchesInFlightMax = Math.max(this.stats.batchesInFlightMax, this.inFlight);
    this.post(buf, len);
  }

  /**
   * The worker's `input-ack`: the buffer comes back and the next batch may go. `depth` is the
   * number of batches the worker held unapplied when this one arrived, this one included (1).
   */
  acked(buf: ArrayBuffer, depth = 1): void {
    this.stats.batchesInFlightMax = Math.max(this.stats.batchesInFlightMax, depth);
    if (this.closed) return;
    this.inFlight = Math.max(0, this.inFlight - 1);
    if (buf.byteLength === BATCH_BYTES && this.free.length < 2) this.free.push(buf);
    this.schedule(this.raf);
  }

  protected enqueue(r: Rec, key = `${String(r.kind)}:${String(r.frame)}`): void {
    if (this.closed) return;
    if (r.discrete !== true && this.pending.delete(key)) {
      this.stats.coalesced += 1;
    } else if (r.discrete === true) {
      this.capSelects(r.frame);
    }
    this.pending.set(key, r);
    this.schedule(this.raf);
  }

  protected countOverflow(): void {
    this.stats.overflow += 1;
  }
}
