/**
 * unit:input-ring, producer leg (plan #68 C2a1 §3.1, §3.3, §4.1, §5 `ring`, `seq`; T03-004
 * revised, T03-006, T03-020): records are written in the T03 §5.4 format, the free-running `u32`
 * counters roll over 2³² without overwriting, a record that would cross the end leaves a wrap
 * marker, a publish wakes an idle worker once, unpublished records coalesce per kind and frame, and
 * seqs are per frame, assigned at publish, consecutive and never 0. The worker's side is
 * `test/ringView.ts`.
 */
import { describe, expect, it } from 'vitest';
import { CB, KIND_CAMERA, KIND_RESIZE, memory, RING, RingView } from '../../test/ringView';
import type { CameraState } from './frame';
import { extendSeq, InputRing } from './ring';

const cam = (lo: number, hi: number): CameraState => ({
  view: { lo, hi },
  value: null,
  band: null,
});

function ring(o: { start?: number; idle?: 0 | 1; firstSeq?: number } = {}) {
  const m = memory();
  const v = new RingView(m);
  if (o.start !== undefined) v.setCounters(o.start);
  v.setIdle(o.idle ?? 0);
  const wakes: number[] = [];
  const r = new InputRing(
    m,
    CB,
    () => {
      wakes.push(1);
    },
    { now: () => 12.5, ...(o.firstSeq === undefined ? {} : { firstSeq: o.firstSeq }) },
  );
  return { r, v, wakes };
}

/** Publishes Cameras of frame `frame` until the ring is full (the next one would be pending). */
function fill(r: InputRing, frame: number): void {
  for (let i = 0; i < 2000 && r.unpublished(frame) === 0; i++) r.camera(frame, cam(i, i + 1));
  r.drop(frame);
}

describe('InputRing (T03 §5.4)', () => {
  it('writes Camera and Resize records in the T03 format', () => {
    const { r, v } = ring();
    r.camera(1, cam(10, 20));
    const d = v.data;
    expect([d.getUint8(0), d.getUint8(1), d.getUint16(2, true), d.getUint32(4, true)]).toEqual([
      KIND_CAMERA,
      0,
      64,
      1,
    ]);
    expect(d.getFloat64(8, true)).toBe(12.5);
    expect(d.getUint32(16, true)).toBe(1);
    expect([d.getFloat64(24, true), d.getFloat64(32, true)]).toEqual([10, 20]);
    expect([40, 48, 56].map((o) => Number.isNaN(d.getFloat64(o, true)))).toEqual([
      true,
      true,
      true,
    ]);
    expect(v.head()).toBe(64);
    r.camera(1, { view: { lo: 1, hi: 2 }, value: { min: 0, max: 5 }, band: 60 });
    expect([d.getFloat64(64 + 40, true), d.getFloat64(64 + 48, true)]).toEqual([0, 5]);
    expect(d.getFloat64(64 + 56, true)).toBe(60);
    r.resize(2, 300.3, 150, 1.25);
    const at = 128;
    expect([d.getUint8(at), d.getUint16(at + 2, true), d.getUint32(at + 4, true)]).toEqual([
      KIND_RESIZE,
      40,
      1,
    ]);
    expect([
      d.getFloat32(at + 16, true),
      d.getFloat32(at + 20, true),
      d.getFloat32(at + 24, true),
    ]).toEqual([Math.fround(300.3), 150, 1.25]);
    expect([d.getUint32(at + 28, true), d.getUint32(at + 32, true)]).toEqual([375, 188]);
    expect(d.getUint32(at + 36, true)).toBe(2);
    expect(v.head()).toBe(168);
  });

  it('rolls over 2³² full without overwriting, and publishes once space is free', () => {
    const { r, v } = ring({ start: 0xffff_ff00 });
    const seqs: number[] = [];
    r.onPublish(1, (_k, s) => seqs.push(s));
    for (let i = 0; i < 1024; i++) r.camera(1, cam(i, i + 1));
    expect(seqs).toHaveLength(1024);
    expect((v.head() - v.tail()) >>> 0).toBe(65_536);
    const headFull = v.head();
    r.camera(1, cam(5000, 5001));
    expect(r.unpublished(1)).toBe(1);
    expect(v.head()).toBe(headFull);
    // The oldest record is intact: no overwrite.
    expect(v.data.getUint32(0xff00 + 4, true)).toBe(1);
    v.setTail(v.head());
    r.flush();
    expect(r.unpublished(1)).toBe(0);
    expect(v.head()).toBe((headFull + 64) >>> 0);
    expect(v.decode().map((x) => [x.seq, x.f[0]])).toEqual([[1025, 5000]]);
  });

  it('leaves a wrap marker when a record would cross the end', () => {
    const { r, v } = ring({ start: RING - 24 });
    r.camera(3, cam(1, 2));
    expect(v.data.getUint8(RING - 24)).toBe(0);
    expect(v.data.getUint8(0)).toBe(KIND_CAMERA);
    expect(v.head()).toBe(RING - 24 + 88);
    expect(r.stats.publishedBytes).toBe(88);
    expect(v.decode().map((x) => [x.at, x.frame])).toEqual([[0, 3]]);
  });

  it('wakes an idle worker once per idle period, by clearing its idle word', () => {
    const { r, v, wakes } = ring({ idle: 1 });
    r.camera(1, cam(1, 2));
    expect(wakes).toHaveLength(1);
    expect(v.idle()).toBe(0);
    r.camera(1, cam(1, 3));
    expect(wakes).toHaveLength(1);
    v.setIdle(1);
    for (let i = 0; i < 3; i++) r.resize(2, 100 + i, 50, 1);
    expect(wakes).toHaveLength(2);
  });

  it('coalesces unpublished records per kind and frame, in the order of their last call', () => {
    const { r, v } = ring();
    fill(r, 9);
    r.camera(1, cam(1, 2));
    r.resize(2, 300, 150, 1);
    r.camera(1, cam(1, 3));
    expect([r.unpublished(1), r.unpublished(2), r.stats.coalesced]).toEqual([1, 1, 1]);
    v.decode();
    r.flush();
    const got = v.decode();
    expect(got.map((x) => [x.kind, x.frame])).toEqual([
      [KIND_RESIZE, 2],
      [KIND_CAMERA, 1],
    ]);
    expect(got[1]?.f[1]).toBe(3);
    // Up to 32 pending records are published before a new one, which then joins the rest.
    fill(r, 9);
    for (let f = 100; f < 140; f++) r.camera(f, cam(f, f + 1));
    v.decode();
    r.camera(200, cam(1, 2));
    expect(v.decode().map((x) => x.frame)).toEqual(Array.from({ length: 32 }, (_, i) => 100 + i));
    expect(r.unpublished(200)).toBe(1);
    r.flush();
    expect(v.decode().map((x) => x.frame)).toEqual([132, 133, 134, 135, 136, 137, 138, 139, 200]);
  });
});

describe('seqs (plan #68 C2a1 §3.1)', () => {
  it('are per frame, from firstSeq, consecutive and never 0 on the wire', () => {
    for (const first of [0x7fff_fff0, 0xffff_fff0]) {
      const { r, v } = ring({ firstSeq: first });
      const ext: number[] = [];
      r.onPublish(1, (_k, s) => ext.push(s));
      const wire: number[] = [];
      for (let i = 0; i < 40; i++) {
        r.camera(1, cam(i, i + 1));
        if (i % 2 === 0) r.resize(2, 10 + i, 10, 1);
        wire.push(
          ...v
            .decode()
            .filter((x) => x.frame === 1)
            .map((x) => x.seq),
        );
      }
      const want: number[] = [];
      for (let p = first; want.length < 40; p++) if (p % 2 ** 32 !== 0) want.push(p);
      expect(ext).toEqual(want);
      expect(wire).toEqual(want.map((p) => p % 2 ** 32));
      expect(wire).not.toContain(0);
    }
  });

  it('are assigned only at publish: 10⁵ coalesced calls settle at the last published seq', () => {
    const { r, v } = ring();
    const A = 1;
    let last = 0;
    let count = 0;
    r.onPublish(A, (_k, s) => {
      expect(s).toBe(last + 1);
      last = s;
      count += 1;
    });
    fill(r, 9);
    let ack = 0;
    let calls = 0;
    const settled = (): boolean => r.unpublished(A) === 0 && extendSeq(last, ack) >= last;
    for (let batch = 0; calls < 100_000; batch++) {
      const n = 1 + (batch % 50);
      for (let i = 0; i < n; i++, calls++) r.camera(A, cam(calls, calls + 1));
      if (r.unpublished(A) > 0) expect(settled()).toBe(false);
      for (const x of v.decode(2)) if (x.frame === A) ack = x.seq;
      r.flush();
      fill(r, 9);
    }
    for (const x of v.decode()) if (x.frame === A) ack = x.seq;
    r.flush();
    for (const x of v.decode()) if (x.frame === A) ack = x.seq;
    expect(settled()).toBe(true);
    expect(extendSeq(last, ack)).toBe(last);
    expect(r.stats.coalesced).toBe(calls - count);
    expect(count).toBeLessThan(calls);
  });

  it('extendSeq takes a u32 ack to the largest seq ≤ P congruent to it', () => {
    expect(extendSeq(2 ** 31 + 5, 2 ** 31 - 10)).toBe(2 ** 31 - 10);
    // A stale drawn does not settle.
    expect(extendSeq(0x8000_0010, 0x7fff_fff0)).toBe(0x7fff_fff0);
    expect(extendSeq(0x8000_0010, 0x7fff_fff0) >= 0x8000_0010).toBe(false);
    expect(extendSeq(2 ** 32 + 3, 0xffff_fff0)).toBe(2 ** 32 - 16);
    expect(extendSeq(2 ** 32 + 3, 3)).toBe(2 ** 32 + 3);
  });

  it('a zero-size frame that never draws is acked by `applied` within one ring of lag', () => {
    const { r, v } = ring();
    const Z = 5;
    const B = 6;
    let pz = 0;
    let pb = 0;
    r.onPublish(Z, (_k, s) => {
      expect(s).toBe(pz + 1);
      pz = s;
    });
    r.onPublish(B, (_k, s) => {
      expect(s).toBe(pb + 1);
      pb = s;
    });
    let ack = 0;
    let maxLag = 0;
    const drain = (): void => {
      maxLag = Math.max(maxLag, pz - extendSeq(pz, ack));
      for (const x of v.decode()) if (x.frame === Z) ack = x.seq;
    };
    for (let cycle = 0; cycle < 20; cycle++) {
      for (let i = 0; i < 1500; i++) {
        r.camera(Z, cam(i, i + 1));
        if (i % 7 === 0) r.resize(B, 10 + i, 10, 1);
        if (r.unpublished(Z) + r.unpublished(B) > 0) {
          drain();
          r.flush();
        }
      }
      drain();
      expect(extendSeq(pz, ack)).toBe(pz);
    }
    expect(pz).toBe(20 * 1500);
    expect(maxLag).toBeLessThanOrEqual(1638);
  });
});
