/**
 * The render worker's side of the input ring, for the adapter's tests (plan #68 C2a1 §3.1): a
 * control block in a `SharedArrayBuffer` (an engine memory as `InputRing` sees it), its counters
 * and a decoder of the published records that consumes them (tail := head, as `drain`). The
 * offsets are T03 §4.3 and §5.4, written out so the tests check the contract, not the generated
 * file.
 */
export const CB = 0x40000;
export const RING = 0x10000;
const HEAD = 0x80;
const TAIL = 0xc0;
const OVERFLOW = 0xc4;
const IDLE = 0xc8;
const DATA = 0x10000;
export const KIND_RESIZE = 0x20;
export const KIND_CAMERA = 0x23;

export interface Decoded {
  readonly kind: number;
  readonly size: number;
  readonly seq: number;
  readonly frame: number;
  /** Physical offset in the ring. */
  readonly at: number;
  readonly tMs: number;
  /** Resize: css w, h, dpr, device w, h. Camera: view lo, hi, value min, max, band. */
  readonly f: readonly number[];
}

/** An engine memory of 1 MiB with the control block at `CB`. */
export function memory(): WebAssembly.Memory {
  return { buffer: new SharedArrayBuffer(1 << 20) } as unknown as WebAssembly.Memory;
}

export class RingView {
  readonly i32: Int32Array;
  readonly data: DataView;

  constructor(m: WebAssembly.Memory, cb = CB) {
    this.i32 = new Int32Array(m.buffer, cb, 0x40000 / 4);
    this.data = new DataView(m.buffer, cb + DATA, RING);
  }

  private load(off: number): number {
    return Atomics.load(this.i32, off / 4) >>> 0;
  }

  private store(off: number, v: number): void {
    Atomics.store(this.i32, off / 4, v | 0);
  }

  head(): number {
    return this.load(HEAD);
  }

  tail(): number {
    return this.load(TAIL);
  }

  idle(): number {
    return this.load(IDLE);
  }

  overflow(): number {
    return this.load(OVERFLOW);
  }

  setIdle(v: 0 | 1): void {
    this.store(IDLE, v);
  }

  setTail(v: number): void {
    this.store(TAIL, v);
  }

  /** head = tail = `v` (before the ring is made). */
  setCounters(v: number): void {
    this.store(HEAD, v);
    this.store(TAIL, v);
  }

  /** Reads up to `limit` records from the tail and consumes them. */
  decode(limit = Infinity): Decoded[] {
    const out: Decoded[] = [];
    const head = this.head();
    let pos = this.tail();
    const d = this.data;
    while (pos !== head && out.length < limit) {
      const at = pos & (RING - 1);
      const kind = d.getUint8(at);
      if (kind === 0) {
        pos = (pos + (RING - at)) >>> 0;
        continue;
      }
      const size = d.getUint16(at + 2, true);
      if (size < 16) break;
      const seq = d.getUint32(at + 4, true);
      const tMs = d.getFloat64(at + 8, true);
      const resize = kind === KIND_RESIZE;
      const frame = d.getUint32(at + (resize ? 36 : 16), true);
      const f = resize
        ? [
            d.getFloat32(at + 16, true),
            d.getFloat32(at + 20, true),
            d.getFloat32(at + 24, true),
            d.getUint32(at + 28, true),
            d.getUint32(at + 32, true),
          ]
        : [24, 32, 40, 48, 56].map((o) => d.getFloat64(at + o, true));
      out.push({ kind, size, seq, frame, at, tMs, f });
      pos = (pos + size) >>> 0;
    }
    this.setTail(pos);
    return out;
  }
}
