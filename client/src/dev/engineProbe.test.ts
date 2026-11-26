/**
 * `__dashProbe`'s settle (plan #68 C2a1 §3.4, §5 `probe settle`; T03-024: fault builds only): a
 * probe frame is settled when it has nothing held or unpublished, the worker acknowledged every
 * published record (`applied`), and, at a non-zero size, presented the last one (`drawn.seq`).
 * The worker is simulated: the ring is read by `test/ringView.ts` and the events are handed to the
 * frames.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CB, KIND_CAMERA, KIND_OVERLAY, KIND_RESIZE, memory, RingView } from '../test/ringView';
import type { FrameInit } from '../engine/api';
import type { Backend, ProbeHost } from '../engine/wasm/engine';
import { WasmFrame } from '../engine/wasm/frame';
import { InputRing } from '../engine/wasm/ring';
import { createProbe } from './engineProbe';

const SPEC = { kind: 'line', title: 'p', unit: { kind: 'none' } } as const;
const SUMMARY = {
  kind: 'line',
  seriesTotal: 1,
  seriesShown: 1,
  fromMs: 0,
  toMs: 10,
  min: 1,
  max: 1,
  last: 1,
  plot: { x: 0, y: 0, width: 300, height: 150 },
  valueAxis: { min: 0, max: 2, manual: false },
  thresholdLabels: [],
  eventLabels: [],
} as const;

beforeEach(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen', {
    configurable: true,
    value() {
      return {} as OffscreenCanvas;
    },
  });
});
afterEach(() => {
  Reflect.deleteProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen');
  document.body.replaceChildren();
});

function setup() {
  const m = memory();
  const view = new RingView(m);
  const ring = new InputRing(m, CB, () => undefined, { log: true });
  const frames: WasmFrame[] = [];
  let id = 0;
  const backend: Backend = {
    tier: 't2',
    createFrame(canvas: OffscreenCanvas, init: FrameInit, onFail: (r: string) => void) {
      const f = new WasmFrame({ postMessage: () => undefined }, ++id, canvas, init, onFail);
      frames.push(f);
      return f;
    },
  };
  const host: ProbeHost = {
    ring,
    counters: () => ({ head: view.head(), tail: view.tail() }),
    overflow: () => view.overflow(),
    idle: () => view.idle() === 1,
    inputLog: () => Promise.resolve([]),
    bad: () => 0,
    freeze: () => undefined,
    unfreeze: () => undefined,
    renew: () => undefined,
  };
  const probe = createProbe({ backend: () => Promise.resolve(backend), host: () => host });
  return { ring, view, frames, probe };
}

/** Fills the ring with records of a frame no probe frame uses. */
function fill(ring: InputRing): void {
  for (let i = 0; i < 2000 && ring.unpublished(99) === 0; i++) {
    ring.camera(99, { view: { lo: i, hi: i + 1 }, value: null, band: null });
  }
  ring.drop(99);
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** Whether `settle(n)` resolves within 80 ms. */
async function settles(p: ReturnType<typeof createProbe>, n: number): Promise<boolean> {
  return Promise.race([
    p.settle(n).then(() => true),
    new Promise<boolean>((r) => {
      setTimeout(() => {
        r(false);
      }, 80);
    }),
  ]);
}

const applied = (f: WasmFrame, seq: number): void => {
  f.handle({ t: 'applied', id: f.id, seq });
};
const drawn = (f: WasmFrame, seq: number, rseq: number, w = 300): void => {
  f.handle({
    t: 'drawn',
    id: f.id,
    ev: { cssWidth: w, cssHeight: 150, dpr: 1 },
    startMs: 1,
    endMs: 2,
    series: 1,
    seq,
    rseq,
  });
};

describe('__dashProbe settle (plan #68 C2a1 §3.4)', () => {
  it('settles only when every published record is applied and the last one drawn', async () => {
    const { ring, view, frames, probe } = setup();
    const opts = {
      spec: SPEC,
      series: [{ key: '00000000000000aa', t: [0, 10], v: [1, 1] }],
      w: { fromMs: 0, toMs: 10 },
      size: [300, 150] as [number, number],
    };
    const pa = probe.frame(opts);
    const pb = probe.frame(opts);
    await flush();
    expect(frames).toHaveLength(2);
    const [A, B] = frames;
    if (A === undefined || B === undefined) throw new Error('no frames');
    // A full ring: the frames' held records go pending, A's camera and overlay are replaced
    // (coalesced; plan #68 C2b: every layout input also writes the frame's Overlay).
    fill(ring);
    A.created(ring);
    B.created(ring);
    A.handle({ t: 'a11y', id: A.id, ev: SUMMARY });
    B.handle({ t: 'a11y', id: B.id, ev: SUMMARY });
    const [na, nb] = await Promise.all([pa, pb]);
    probe.call(na, 'setTimeWindow', { fromMs: 2, toMs: 8 });
    expect(probe.stats().coalesced).toBe(2);
    expect(await settles(probe, na)).toBe(false);
    view.decode();
    ring.flush();
    const recs = view.decode();
    expect(recs.map((r) => [r.frame, r.kind, r.seq])).toEqual([
      [A.id, KIND_RESIZE, 1],
      [B.id, KIND_CAMERA, 1],
      [B.id, KIND_OVERLAY, 2],
      [B.id, KIND_RESIZE, 3],
      [A.id, KIND_CAMERA, 2],
      [A.id, KIND_OVERLAY, 3],
    ]);
    // A's camera is the second call's.
    expect(recs[4]?.f.slice(0, 2)).toEqual([2, 8]);
    applied(A, 3);
    drawn(A, 3, 1);
    applied(B, 3);
    drawn(B, 3, 3);
    expect(await settles(probe, na)).toBe(true);
    expect(await settles(probe, nb)).toBe(true);
    expect(probe.last(na)).toEqual(SUMMARY);
    expect(probe.drawn(na)).toEqual([{ cssWidth: 300, cssHeight: 150, dpr: 1 }]);

    // A resize (with the controller's camera, plan #68 C2a2): not while pending, nor by a late
    // drawn of the old size.
    fill(ring);
    probe.call(na, 'resize', [400, 150, 1]);
    expect(await settles(probe, na)).toBe(false);
    drawn(A, 3, 1);
    expect(await settles(probe, na)).toBe(false);
    view.decode();
    ring.flush();
    expect(view.decode().map((r) => [r.frame, r.kind, r.seq])).toEqual([
      [A.id, KIND_CAMERA, 4],
      [A.id, KIND_OVERLAY, 5],
      [A.id, KIND_RESIZE, 6],
    ]);
    // `applied` alone does not settle a frame of non-zero size; with its `drawn` it does.
    applied(A, 6);
    expect(await settles(probe, na)).toBe(false);
    drawn(A, 6, 6, 400);
    expect(await settles(probe, na)).toBe(true);
    // `drawn` alone does not settle either.
    probe.call(nb, 'resize', [500, 150, 1]);
    expect(view.decode().map((r) => [r.frame, r.seq])).toEqual([
      [B.id, 4],
      [B.id, 5],
      [B.id, 6],
    ]);
    drawn(B, 6, 6, 500);
    expect(await settles(probe, nb)).toBe(false);
    applied(B, 6);
    expect(await settles(probe, nb)).toBe(true);
    expect(probe.drawn(nb).at(-1)).toEqual({ cssWidth: 500, cssHeight: 150, dpr: 1 });
    expect(probe.producedLog().length).toBeGreaterThan(1024);
    expect(probe.counters()).toEqual({ head: view.head(), tail: view.tail() });
  });

  it('a zero-size frame settles on `applied` alone', async () => {
    const { ring, view, frames, probe } = setup();
    const p = probe.frame({
      spec: SPEC,
      series: [],
      w: { fromMs: 0, toMs: 10 },
      size: [0, 0],
    });
    await flush();
    expect(frames).toHaveLength(1);
    const [Z] = frames;
    if (Z === undefined) throw new Error('no frame');
    Z.created(ring);
    Z.handle({ t: 'a11y', id: Z.id, ev: SUMMARY });
    const n = await p;
    expect(view.decode().map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(await settles(probe, n)).toBe(false);
    applied(Z, 3);
    expect(await settles(probe, n)).toBe(true);
  });

  it('a camera the worker rejects settles on the redraw that carries its seq (review r1)', async () => {
    const { ring, view, frames, probe } = setup();
    const p = probe.frame({
      spec: SPEC,
      series: [{ key: '00000000000000aa', t: [0, 10], v: [1, 1] }],
      w: { fromMs: 0, toMs: 10 },
      size: [300, 150],
    });
    await flush();
    expect(frames).toHaveLength(1);
    const [A] = frames;
    if (A === undefined) throw new Error('no frame');
    A.created(ring);
    A.handle({ t: 'a11y', id: A.id, ev: SUMMARY });
    const n = await p;
    expect(view.decode().map((r) => r.seq)).toEqual([1, 2, 3]);
    applied(A, 3);
    drawn(A, 3, 3);
    expect(await settles(probe, n)).toBe(true);
    // An empty window: the worker rejects it but presents the unchanged state with its seq.
    probe.call(n, 'setTimeWindow', { fromMs: 5, toMs: 5 });
    expect(view.decode().map((r) => r.seq)).toEqual([4, 5]);
    expect(await settles(probe, n)).toBe(false);
    applied(A, 5);
    drawn(A, 5, 3);
    expect(await settles(probe, n)).toBe(true);
    expect(probe.drawn(n).at(-1)).toEqual({ cssWidth: 300, cssHeight: 150, dpr: 1 });
    expect(probe.last(n)).toEqual(SUMMARY);
  });
});
