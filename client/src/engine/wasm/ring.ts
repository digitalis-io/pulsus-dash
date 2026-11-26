/**
 * The input ring's producer (plan #68 C2a1 §3.1, §3.3, §4.1; T03 §5.4, T03-004 revised, T03-006,
 * T03-020): the main thread writes Resize and Camera records into the control block's ring and the
 * render worker reads them at the start of its next tick. One ring per engine memory (each status
 * gets a new one).
 *
 * | Step | Behaviour |
 * |---|---|
 * | counters | free-running `u32` byte counts: occupied = `(head − tail) >>> 0`; the physical offset = `head & (RING − 1)`; loads `>>> 0`, stores `\| 0` |
 * | publish | the size, plus the gap to the end when the record would cross it (a Wrap byte there); too little free → pending; else the payload (`DataView`, little-endian), then `Atomics.store(HEAD)` |
 * | pending | `Map<'kind:frame'>`, no seqs; a replacement deletes, then inserts (to the end): `coalesced` |
 * | order | up to 32 pending are published before a new record; if any remain it joins them; an animation frame publishes up to 256 |
 * | seq | per frame from `firstSeq` (1), assigned at publish; the wire carries `P mod 2³²`, a `P ≡ 0` is skipped; `onPublish` gets `P` (53-bit) |
 * | wake | after each publish `Atomics.compareExchange(IDLE, 1, 0) === 1` → `wake()`: at most one per idle period |
 *
 * Nothing is dropped: a record that does not fit waits (only the latest per kind and frame is
 * kept), so `INPUT_OVERFLOW` stays 0 until #94 brings discrete records.
 */
import type { CameraState } from './frame';
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
  OFF_INPUT_TAIL,
  REC_CAMERA,
  REC_CAMERA_BYTES,
  REC_RESIZE,
  REC_RESIZE_BYTES,
  REC_WRAP,
  RESIZE_CSS_H,
  RESIZE_CSS_W,
  RESIZE_DEVICE_H,
  RESIZE_DEVICE_W,
  RESIZE_DPR,
  RESIZE_FRAME,
  RING_BYTES,
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

interface Rec {
  readonly kind: number;
  readonly frame: number;
  readonly size: number;
  readonly tMs: number;
  /** Writes the payload at `at` (header excluded). */
  readonly write: (d: DataView, at: number) => void;
  readonly f: readonly (number | null)[];
}

const nul = (v: number): number | null => (Number.isNaN(v) ? null : v);

export class InputRing {
  readonly stats = { coalesced: 0, publishedBytes: 0 };
  /** Every published record, in order (`log` only). */
  produced: InputRec[] | null;
  private readonly i32: Int32Array;
  private readonly data: DataView;
  private head: number;
  private readonly pending = new Map<string, Rec>();
  private readonly seqs = new Map<number, number>();
  private readonly listeners = new Map<number, (kind: number, seq: number) => void>();
  private readonly now: () => number;
  private readonly firstSeq: number;
  private readonly wake: () => void;
  private scheduled = false;
  private closed = false;

  constructor(memory: WebAssembly.Memory, cb: number, wake: () => void, o: RingOptions = {}) {
    this.wake = wake;
    this.i32 = new Int32Array(memory.buffer, cb, CB_BYTES / 4);
    this.data = new DataView(memory.buffer, cb + OFF_INPUT_DATA, RING_BYTES);
    this.head = this.load(OFF_INPUT_HEAD);
    this.now = o.now ?? (() => performance.now());
    this.firstSeq = o.firstSeq ?? 1;
    this.produced = o.log === true ? [] : null;
  }

  private load(off: number): number {
    return Atomics.load(this.i32, off / 4) >>> 0;
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

  /** Publishes up to 256 pending records (each animation frame while any are pending). */
  flush(): void {
    this.scheduled = false;
    this.publishPending(PER_FLUSH);
    this.schedule();
  }

  /** The engine this ring writes to is gone (a restart, a fatal failure): nothing more. */
  close(): void {
    this.closed = true;
    this.pending.clear();
    this.listeners.clear();
  }

  private enqueue(r: Rec): void {
    if (this.closed) return;
    const key = `${String(r.kind)}:${String(r.frame)}`;
    if (this.pending.delete(key)) {
      this.stats.coalesced += 1;
      this.pending.set(key, r);
      return;
    }
    this.publishPending(BEFORE_OWN);
    if (this.pending.size > 0 || !this.publish(r)) this.pending.set(key, r);
    this.schedule();
  }

  private publishPending(max: number): void {
    let n = 0;
    for (const [k, r] of this.pending) {
      if (n >= max || !this.publish(r)) return;
      this.pending.delete(k);
      n++;
    }
  }

  private schedule(): void {
    if (this.scheduled || this.closed || this.pending.size === 0) return;
    this.scheduled = true;
    const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => number })
      .requestAnimationFrame;
    const run = (): void => {
      this.flush();
    };
    if (typeof raf === 'function') raf.call(globalThis, run);
    else setTimeout(run, 16);
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
    let p = (this.seqs.get(r.frame) ?? this.firstSeq - 1) + 1;
    if (p % 2 ** 32 === 0) p += 1;
    this.seqs.set(r.frame, p);
    const seq = p >>> 0;
    d.setUint8(at, r.kind);
    d.setUint8(at + 1, 0);
    d.setUint16(at + 2, r.size, true);
    d.setUint32(at + 4, seq, true);
    d.setFloat64(at + 8, r.tMs, true);
    r.write(d, at);
    this.head = (this.head + gap + r.size) >>> 0;
    Atomics.store(this.i32, OFF_INPUT_HEAD / 4, this.head | 0);
    this.stats.publishedBytes += gap + r.size;
    if (this.produced !== null && this.produced.length < MAX_LOG) {
      this.produced.push({ seq, kind: r.kind, frame: r.frame, tMs: r.tMs, f: r.f });
    }
    this.listeners.get(r.frame)?.(r.kind, p);
    if (Atomics.compareExchange(this.i32, OFF_INPUT_IDLE / 4, 1, 0) === 1) this.wake();
    return true;
  }
}
