/**
 * unit:input-batch (plan #68 C2d2 §3.2, §5 `batch ring`, `st backlog`; T03 §9.2, T03-019,
 * T03-020): the ST engine's `BatchRing` writes the same record bytes as `InputRing` into a
 * transferable batch, one batch per animation frame, at most one unacknowledged; pending records
 * coalesce per kind and frame, Selects are capped at 8 per frame and counted when dropped, and a
 * slow worker that acknowledges only after the tick that applied the batch never leaves more than
 * one batch in flight.
 */
import { describe, expect, it, vi } from 'vitest';
import { CB, KIND_CAMERA, KIND_RESIZE, KIND_SELECT, memory, RingView } from '../../test/ringView';
import type { CameraState } from './frame';
import { BatchRing, InputRing } from './ring';

const cam = (lo: number, hi: number): CameraState => ({
  view: { lo, hi },
  value: null,
  band: null,
});

const BATCH = 64 * 1024;

interface Posted {
  readonly buf: ArrayBuffer;
  readonly len: number;
  /** A copy of the records (the buffer is handed back later). */
  readonly bytes: Uint8Array;
}

/** A `BatchRing` with a fake `post` and a manual animation frame. */
function batch(o: { firstSeq?: number } = {}) {
  const posts: Posted[] = [];
  const frames: (() => void)[] = [];
  const r = new BatchRing(
    (buf, len) => {
      posts.push({ buf, len, bytes: new Uint8Array(buf, 0, len).slice() });
    },
    {
      now: () => 12.5,
      raf: (cb) => {
        frames.push(cb);
      },
      ...(o.firstSeq === undefined ? {} : { firstSeq: o.firstSeq }),
    },
  );
  /** Runs the animation frames requested so far. */
  const rafTick = (): void => {
    for (const cb of frames.splice(0)) cb();
  };
  return { r, posts, rafTick };
}

/** Records of a batch: kind, size, seq, frame. */
function records(
  b: Uint8Array,
): { kind: number; size: number; seq: number; frame: number; v: number }[] {
  const d = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out = [];
  for (let at = 0; at < b.byteLength;) {
    const kind = d.getUint8(at);
    const size = d.getUint16(at + 2, true);
    const frame = d.getUint32(at + (kind === KIND_RESIZE ? 36 : 16), true);
    // The payload's first value: Camera view lo, Resize CSS width, Overlay key, Select x.
    const v =
      kind === KIND_CAMERA
        ? d.getFloat64(at + 24, true)
        : kind === KIND_RESIZE
          ? d.getFloat32(at + 16, true)
          : kind === 0x24
            ? d.getUint32(at + 40, true)
            : d.getFloat64(at + 24, true);
    out.push({ kind, size, seq: d.getUint32(at + 4, true), frame, v });
    if (size < 16) break;
    at += size;
  }
  return out;
}

/** The same calls on an `InputRing` (nothing coalesces there: every record is published). */
function ringBytes(calls: (r: InputRing | BatchRing) => void): Uint8Array {
  const m = memory();
  const v = new RingView(m);
  v.setIdle(0);
  const r = new InputRing(m, CB, () => undefined, { now: () => 12.5 });
  calls(r);
  const head = v.head();
  return new Uint8Array(v.data.buffer, v.data.byteOffset, head).slice();
}

describe('BatchRing (plan #68 C2d2 §3.2)', () => {
  it('one batch per animation frame, none until acked; the same bytes as InputRing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { r, posts, rafTick } = batch();
      const seqs: [number, number, number][] = [];
      r.onPublish(1, (k, s) => seqs.push([1, k, s]));
      r.onPublish(2, (k, s) => seqs.push([2, k, s]));
      for (let i = 0; i < 3; i++) r.camera(1, cam(i, i + 10));
      r.resize(2, 300.5, 150, 1.25);
      for (let i = 0; i < 10; i++) r.select(1, i, 2 * i);
      // Nothing goes before the animation frame.
      expect(posts).toHaveLength(0);
      expect(r.unpublished(1)).toBe(1 + 8);
      expect(r.unpublished(2)).toBe(1);
      expect(r.stats.coalesced).toBe(2);
      expect(r.stats.overflow).toBe(2);
      expect(r.stats.selects).toBe(10);
      expect(warn).toHaveBeenCalledTimes(1);
      rafTick();
      expect(posts).toHaveLength(1);
      const p = posts[0];
      if (p === undefined) throw new Error('no batch');
      expect(p.buf.byteLength).toBe(BATCH);
      const recs = records(p.bytes);
      expect(recs.map((x) => x.kind)).toEqual([
        KIND_CAMERA,
        KIND_RESIZE,
        ...Array<number>(8).fill(KIND_SELECT),
      ]);
      // Seqs per frame, consecutive, assigned at the copy.
      expect(recs.filter((x) => x.frame === 1).map((x) => x.seq)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9,
      ]);
      expect(recs.filter((x) => x.frame === 2).map((x) => x.seq)).toEqual([1]);
      expect(seqs.filter((s) => s[0] === 1).map((s) => s[2])).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(r.unpublished(1)).toBe(0);
      expect(r.stats.publishedBytes).toBe(p.len);
      // The bytes are InputRing's for the calls that were not coalesced or dropped.
      const want = ringBytes((x) => {
        x.camera(1, cam(2, 12));
        x.resize(2, 300.5, 150, 1.25);
        for (let i = 2; i < 10; i++) x.select(1, i, 2 * i);
      });
      expect([...p.bytes]).toEqual([...want]);

      // In flight: later calls wait, whatever the animation frames, until the ack.
      r.camera(1, cam(100, 200));
      rafTick();
      rafTick();
      expect(posts).toHaveLength(1);
      expect(r.unpublished(1)).toBe(1);
      r.acked(p.buf);
      rafTick();
      expect(posts).toHaveLength(2);
      expect(records(posts[1]?.bytes ?? new Uint8Array()).map((x) => x.seq)).toEqual([10]);
      // The two buffers alternate.
      expect(posts[1]?.buf).not.toBe(p.buf);
      expect(r.stats.batches).toBe(2);
      expect(r.stats.batchesInFlightMax).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('70 KiB pending go in two batches, in order', () => {
    const { r, posts, rafTick } = batch();
    // 70 KiB of discrete records over many frames (8 Selects each, 40 B): no coalescing.
    const per = 8;
    const frames = Math.ceil((70 * 1024) / (40 * per));
    for (let f = 1; f <= frames; f++) for (let i = 0; i < per; i++) r.select(f, i, f);
    rafTick();
    expect(posts).toHaveLength(1);
    const first = posts[0];
    if (first === undefined) throw new Error('no batch');
    expect(first.len).toBeLessThanOrEqual(BATCH);
    expect(first.len).toBeGreaterThan(BATCH - 40);
    r.acked(first.buf);
    rafTick();
    expect(posts).toHaveLength(2);
    const all = [...records(first.bytes), ...records(posts[1]?.bytes ?? new Uint8Array())];
    expect(all).toHaveLength(frames * per);
    expect(all.map((x) => x.frame)).toEqual(
      Array.from({ length: frames * per }, (_, i) => 1 + Math.floor(i / per)),
    );
    expect(first.len + (posts[1]?.len ?? 0)).toBe(r.stats.publishedBytes);
    r.acked(posts[1]?.buf ?? new ArrayBuffer(0));
    rafTick();
    expect(posts).toHaveLength(2);
  });

  it('drop forgets a frame; close ends it', () => {
    const { r, posts, rafTick } = batch();
    r.camera(1, cam(0, 1));
    r.camera(2, cam(0, 1));
    r.drop(1);
    rafTick();
    expect(records(posts[0]?.bytes ?? new Uint8Array()).map((x) => x.frame)).toEqual([2]);
    r.close();
    r.acked(posts[0]?.buf ?? new ArrayBuffer(0));
    r.camera(2, cam(1, 2));
    rafTick();
    expect(posts).toHaveLength(1);
  });

  it('seqs skip 0 on the wire across 2³²', () => {
    const { r, posts, rafTick } = batch({ firstSeq: 0xffff_fffe });
    const ext: number[] = [];
    r.onPublish(1, (_k, s) => ext.push(s));
    for (let i = 0; i < 3; i++) r.select(1, i, 0);
    rafTick();
    expect(records(posts[0]?.bytes ?? new Uint8Array()).map((x) => x.seq)).toEqual([
      0xffff_fffe, 0xffff_ffff, 1,
    ]);
    expect(ext).toEqual([0xffff_fffe, 0xffff_ffff, 2 ** 32 + 1]);
  });
});

/** A seeded generator (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('st backlog (plan #68 C2d2 §3.2)', () => {
  it('a slow worker that acks after the applying tick: ≤ 1 batch in flight, nothing lost', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { r, posts, rafTick } = batch();
      const rand = rng(68);
      /** The fake worker: received batches queue in its engine until a tick applies them. */
      const queued: Posted[] = [];
      let acks = 0;
      let inFlight = 0;
      let maxFlight = 0;
      let maxQueued = 0;
      const applied: { kind: number; frame: number; seq: number; v: number }[] = [];
      /** The last call of each kind and frame: `kind:frame` → its first payload value. */
      const lastCall = new Map<string, number>();
      let seen = 0;
      /** Every batch posted reaches the worker at once (`engine_input_batch`). */
      const receive = (): void => {
        for (const p of posts.slice(seen)) {
          queued.push(p);
          inFlight += 1;
        }
        seen = posts.length;
        maxFlight = Math.max(maxFlight, inFlight);
        maxQueued = Math.max(maxQueued, queued.length);
      };
      /** One worker tick: the queued records applied, then each batch acknowledged. */
      const workerTick = (): void => {
        for (const p of queued.splice(0)) {
          applied.push(...records(p.bytes));
          inFlight -= 1;
          acks += 1;
          r.acked(p.buf);
        }
      };
      const frames = [1, 2, 3];
      let selectCalls = 0;
      const pendingBound = frames.length * (3 + 8);
      for (let step = 0, call = 0; step < 2000; step++) {
        // 5 calls per animation frame, 10⁴ in all; 500 of them Selects.
        for (let k = 0; k < 5 && call < 10_000; k++, call++) {
          const f = frames[Math.floor(rand() * 3)] ?? 1;
          if (call % 20 === 0) {
            r.select(f, call, 0);
            selectCalls += 1;
          } else if (call % 3 === 0) {
            r.resize(f, 100 + call, 50, 1);
            lastCall.set(`${String(KIND_RESIZE)}:${String(f)}`, 100 + call);
          } else if (call % 3 === 1) {
            r.camera(f, cam(call, call + 1));
            lastCall.set(`${String(KIND_CAMERA)}:${String(f)}`, call);
          } else {
            r.overlay(f, { hover: { kind: 'key', index: call }, box: null });
            lastCall.set(`36:${String(f)}`, call);
          }
        }
        let pending = 0;
        for (const f of frames) pending += r.unpublished(f);
        expect(pending).toBeLessThanOrEqual(pendingBound);
        rafTick();
        receive();
        // One worker tick per 10 animation frames, then per 100.
        if (step % (step < 1000 ? 10 : 100) === 9) workerTick();
      }
      // Drain: the worker keeps ticking until nothing is pending.
      for (let i = 0; i < 200; i++) {
        rafTick();
        receive();
        workerTick();
      }
      expect(maxFlight).toBe(1);
      expect(maxQueued).toBe(1);
      expect(r.stats.batchesInFlightMax).toBe(1);
      expect(acks).toBe(posts.length);
      for (const f of frames) expect(r.unpublished(f)).toBe(0);
      // The last camera, resize and overlay of each frame were applied at the end.
      for (const f of frames) {
        for (const kind of [KIND_CAMERA, KIND_RESIZE, 0x24]) {
          const last = applied.filter((x) => x.frame === f && x.kind === kind).at(-1);
          expect(last?.v, `frame ${String(f)} kind ${String(kind)}`).toBe(
            lastCall.get(`${String(kind)}:${String(f)}`),
          );
        }
        const seqs = applied.filter((x) => x.frame === f).map((x) => x.seq);
        expect(seqs).toEqual(seqs.map((_, i) => i + 1));
      }
      const selects = applied.filter((x) => x.kind === KIND_SELECT).length;
      expect(selects + r.stats.overflow).toBe(selectCalls);
      expect(r.stats.selects).toBe(selectCalls);
    } finally {
      warn.mockRestore();
    }
  });

  it('a worker depth above 1 in an ack is recorded (the fuzz reads it)', () => {
    const { r, posts, rafTick } = batch();
    r.camera(1, cam(0, 1));
    rafTick();
    r.acked(posts[0]?.buf ?? new ArrayBuffer(0), 2);
    expect(r.stats.batchesInFlightMax).toBe(2);
  });
});
