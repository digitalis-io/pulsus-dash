/**
 * The main-thread side of an engine frame (plan #68 C1 §3.5; C2a1 §4.4; ADR-0019, D-PROTO): spec,
 * data, theme and dispose are messages; the camera and the size go through the input ring, held
 * until the worker reports the frame `created`; `drawn` is reported only for the latest `resize()`
 * call, with the caller's values, once no Resize is held or unpublished.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChartFrame, FrameData, VisSpec } from '../api';
import { CB, memory, RingView } from '../../test/ringView';
import { WasmFrame, type CameraState, type FrameRing, type StageModel } from './frame';
import type { MainToRender, StageWire } from './protocol';
import { InputRing } from './ring';

const S: VisSpec = { kind: 'line', title: 'T', unit: { kind: 'none' } };
const PINNED: VisSpec = { ...S, valueRange: { min: 0, max: 5 } };
const T = new Float64Array([1, 2]);
const V = new Float64Array([3, 4]);
const SERIES: FrameData = {
  kind: 'series',
  series: [{ key: '00000000000000aa', labels: { job: 'api' }, timestamps: T, values: V }],
};
const HEAT: FrameData = {
  kind: 'heatmap',
  heatmap: {
    timestamps: new Float64Array([1]),
    bounds: new Float64Array([1]),
    counts: new Float64Array([1]),
  },
};
const RESIZE = 0x20;
const CAMERA = 0x23;

function port() {
  const sent: { msg: MainToRender; transfer: Transferable[] }[] = [];
  return {
    sent,
    postMessage(msg: MainToRender, transfer: Transferable[] = []): void {
      sent.push({ msg, transfer });
    },
  };
}

type Arg = CameraState | readonly [number, number, number];
type Kind = 'camera' | 'resize';

/** A ring that publishes at once unless `full`; unpublished records coalesce per kind. */
class FakeRing implements FrameRing {
  full = false;
  readonly published: { kind: Kind; frame: number; seq: number; arg: Arg }[] = [];
  readonly dropped: number[] = [];
  private readonly pending = new Map<string, { kind: Kind; frame: number; arg: Arg }>();
  private readonly seqs = new Map<number, number>();
  private readonly cbs = new Map<number, (kind: number, seq: number) => void>();

  camera(frame: number, c: CameraState): void {
    this.put('camera', frame, c);
  }
  resize(frame: number, w: number, h: number, dpr: number): void {
    this.put('resize', frame, [w, h, dpr]);
  }
  onPublish(frame: number, cb: (kind: number, seq: number) => void): void {
    this.cbs.set(frame, cb);
  }
  unpublished(frame: number): number {
    return [...this.pending.values()].filter((p) => p.frame === frame).length;
  }
  drop(frame: number): void {
    for (const [k, p] of this.pending) if (p.frame === frame) this.pending.delete(k);
    this.dropped.push(frame);
  }
  release(): void {
    this.full = false;
    for (const [k, p] of [...this.pending]) {
      this.pending.delete(k);
      this.publish(p.kind, p.frame, p.arg);
    }
  }
  private put(kind: Kind, frame: number, arg: Arg): void {
    const k = `${kind}:${String(frame)}`;
    if (this.full) {
      this.pending.delete(k);
      this.pending.set(k, { kind, frame, arg });
      return;
    }
    this.publish(kind, frame, arg);
  }
  private publish(kind: Kind, frame: number, arg: Arg): void {
    const seq = (this.seqs.get(frame) ?? 0) + 1;
    this.seqs.set(frame, seq);
    this.published.push({ kind, frame, seq, arg });
    this.cbs.get(frame)?.(kind === 'camera' ? CAMERA : RESIZE, seq);
  }
}

const drawn = (o: {
  w: number;
  h?: number;
  dpr?: number;
  seq: number;
  rseq: number;
  at?: number;
}) =>
  ({
    t: 'drawn',
    id: 1,
    ev: { cssWidth: o.w, cssHeight: o.h ?? 150, dpr: o.dpr ?? 1 },
    startMs: o.at ?? 5,
    endMs: (o.at ?? 5) + 2,
    series: 1,
    seq: o.seq,
    rseq: o.rseq,
  }) as const;

function frame(id = 1) {
  const p = port();
  const onFail = vi.fn();
  const canvas = { width: 0, height: 0 } as unknown as OffscreenCanvas;
  const f = new WasmFrame(p, id, canvas, { timeZone: 'UTC', keyTarget: null, id: 'f1' }, onFail);
  const got = vi.fn();
  f.on('drawn', got);
  return { f, p, onFail, canvas, got };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('WasmFrame (ADR-0019, D-PROTO)', () => {
  it('posts spec, data, theme and dispose; holds the camera and size until created', () => {
    const { f, p, onFail, canvas, got } = frame();
    const ring = new FakeRing();
    const measure = vi.spyOn(performance, 'measure');
    f.setSpec(S);
    f.setData(SERIES);
    f.setTimeWindow({ fromMs: 0, toMs: 10 });
    f.setTheme('dark');
    // Through the seam's signatures: kept by the routing frame, not sent (C2).
    const seam: ChartFrame = f;
    seam.setEvents([]);
    seam.setSelection(null);
    f.resize(300, 150, 2);
    expect(ring.published).toEqual([]);
    f.handle(drawn({ w: 300, dpr: 2, seq: 2, rseq: 2 }));
    expect(got).not.toHaveBeenCalled();
    f.created(ring);
    expect(ring.published).toEqual([
      {
        kind: 'camera',
        frame: 1,
        seq: 1,
        arg: { view: { lo: 0, hi: 10 }, value: null, band: null },
      },
      { kind: 'resize', frame: 1, seq: 2, arg: [300, 150, 2] },
    ]);
    f.handle(drawn({ w: 300, dpr: 2, seq: 2, rseq: 2 }));
    f.setData(HEAT);
    f.dispose();
    f.handle(drawn({ w: 300, dpr: 2, seq: 2, rseq: 2, at: 9 }));
    f.handle({ t: 'failed', id: 1, reason: 'readback' });
    f.setSpec(S);
    f.resize(10, 10, 1);
    expect(ring.dropped).toEqual([1]);
    expect(ring.published).toHaveLength(2);
    expect(p.sent.map((s) => s.msg)).toEqual([
      { t: 'create', id: 1, canvas, frameId: 'f1' },
      { t: 'spec', id: 1, json: JSON.stringify(S) },
      {
        t: 'data',
        id: 1,
        series: [{ key: '00000000000000aa', names: ['job'], values: ['api'], t: T, v: V }],
      },
      { t: 'theme', id: 1, theme: 0 },
      { t: 'data', id: 1, series: null },
      { t: 'dispose', id: 1 },
    ]);
    // Only the canvas is transferred; the data arrays stay with the caller (cloned).
    expect(p.sent[0]?.transfer).toEqual([canvas]);
    expect(p.sent.slice(1).every((s) => s.transfer.length === 0)).toBe(true);
    expect(got.mock.calls).toEqual([[{ cssWidth: 300, cssHeight: 150, dpr: 2 }]]);
    const m = measure.mock.calls.filter((c) => c[0] === 'chart-draw');
    expect(m.map((c) => c[1])).toEqual([
      { start: 5, end: 7, detail: { kind: 'line', series: 1, frame: 'f1' } },
    ]);
    expect(onFail).not.toHaveBeenCalled();
  });

  it('reports drawn only for the latest resize, with the caller’s values', () => {
    const { f, got } = frame();
    const ring = new FakeRing();
    f.created(ring);
    f.resize(300, 150, 1);
    f.resize(300, 150, 2);
    f.handle(drawn({ w: 300, dpr: 1, seq: 1, rseq: 1 }));
    expect(got).not.toHaveBeenCalled();
    f.handle(drawn({ w: 300, dpr: 2, seq: 2, rseq: 2 }));
    expect(got.mock.calls).toEqual([[{ cssWidth: 300, cssHeight: 150, dpr: 2 }]]);
    f.resize(300.3, 150, 1);
    f.handle(drawn({ w: Math.fround(300.3), seq: 3, rseq: 3 }));
    expect(got.mock.calls[1]).toEqual([{ cssWidth: 300.3, cssHeight: 150, dpr: 1 }]);
    f.setTimeWindow({ fromMs: 10, toMs: 20 });
    expect(ring.published.at(-1)).toMatchObject({
      kind: 'camera',
      arg: { view: { lo: 10, hi: 20 }, value: null, band: null },
    });
    // A spec with a valid value range pins the idle camera's value; an invalid one does not.
    f.setSpec(PINNED);
    expect(ring.published.at(-1)?.arg).toEqual({
      view: { lo: 10, hi: 20 },
      value: { min: 0, max: 5 },
      band: null,
    });
    f.setSpec({ ...S, valueRange: { min: 5, max: 5 } });
    expect(ring.published.at(-1)?.arg).toEqual({
      view: { lo: 10, hi: 20 },
      value: null,
      band: null,
    });
    f.setCamera({ view: { lo: 1, hi: 2 }, value: null, band: 40 });
    expect(ring.published.at(-1)?.arg).toEqual({ view: { lo: 1, hi: 2 }, value: null, band: 40 });
  });

  it('a resize waiting in a full ring blocks every drawn until it is published', () => {
    const { f, got } = frame();
    const ring = new FakeRing();
    f.created(ring);
    f.resize(300, 150, 1);
    f.resize(300, 150, 2);
    ring.full = true;
    f.resize(0, 150, 1);
    // The worker presents the last published size: not the latest call, so nothing.
    f.handle(drawn({ w: 300, dpr: 2, seq: 2, rseq: 2 }));
    expect(got).not.toHaveBeenCalled();
    f.resize(300, 150, 2);
    ring.release();
    expect(ring.published.at(-1)).toMatchObject({ kind: 'resize', seq: 3, arg: [300, 150, 2] });
    f.handle(drawn({ w: 300, dpr: 2, seq: 3, rseq: 3 }));
    expect(got.mock.calls).toEqual([[{ cssWidth: 300, cssHeight: 150, dpr: 2 }]]);
  });

  it('a11y and failed reach the frame; drawn is never at size 0', () => {
    const { f, onFail, got } = frame();
    const a11y = vi.fn();
    f.on('a11y', a11y);
    f.created(new FakeRing());
    f.resize(0, 150, 1);
    f.handle(drawn({ w: 0, seq: 1, rseq: 1 }));
    expect(got).not.toHaveBeenCalled();
    const summary = {
      kind: 'line',
      seriesTotal: 1,
      seriesShown: 1,
      fromMs: 0,
      toMs: 10,
      min: 3,
      max: 4,
      last: 4,
      plot: { x: 0, y: 0, width: 300, height: 150 },
      valueAxis: { min: 0, max: 5, manual: false },
      thresholdLabels: [],
      eventLabels: [],
    } as const;
    f.handle({ t: 'a11y', id: 1, ev: summary });
    expect(a11y).toHaveBeenCalledWith(summary);
    f.handle({ t: 'failed', id: 1, reason: 'surface' });
    expect(onFail).toHaveBeenCalledWith('surface');
  });
});

/** Fills the ring with records of a frame no test frame uses, until one waits. */
function fill(ring: InputRing): void {
  for (let i = 0; i < 2000 && ring.unpublished(99) === 0; i++) {
    ring.camera(99, { view: { lo: i, hi: i + 1 }, value: null, band: null });
  }
  ring.drop(99);
}

describe('WasmFrame stage (plan #68 C2a2 §3.3)', () => {
  const W1: StageWire = {
    plot: { x: 50, y: 8, width: 742, height: 200 },
    domain: { min: 0, max: 30 },
    labelW: 38,
  };
  const S1: StageModel = {
    plot: W1.plot,
    valueDomain: { min: 0, max: 30 },
    labelW: 38,
    pickCount: 0,
  };

  it('wasm frame stage: the last completed presentation of the latest resize', () => {
    const m = memory();
    const view = new RingView(m);
    const ring = new InputRing(m, CB, () => undefined);
    const { f } = frame();
    const seen: (StageModel | null)[] = [];
    f.onStage((s) => seen.push(s));
    f.created(ring);
    const stage = (rseq: number, st: StageWire | null): void => {
      f.handle({ t: 'stage', id: 1, rseq, stage: st });
    };
    f.resize(800, 240, 1);
    expect(view.decode().map((r) => r.seq)).toEqual([1]);
    expect(f.stage()).toBeNull();
    stage(1, W1);
    expect(f.stage()).toEqual(S1);
    stage(1, null);
    expect(f.stage()).toBeNull();
    stage(1, W1);
    // A drawn without a stage keeps it.
    f.handle(drawn({ w: 800, h: 240, seq: 1, rseq: 1 }));
    expect(f.stage()).toEqual(S1);
    expect(seen).toEqual([S1, null, S1]);

    // (A) A zero size waiting in a full ring: null at once; the valid size replaces it.
    fill(ring);
    f.resize(0, 240, 1);
    expect(f.stage()).toBeNull();
    expect(seen).toEqual([S1, null, S1, null]);
    f.resize(800, 240, 1);
    stage(1, W1);
    expect(f.stage()).toBeNull();
    view.decode();
    ring.flush();
    expect(view.decode().map((r) => [r.frame, r.seq])).toEqual([[1, 2]]);
    stage(1, W1);
    expect(f.stage()).toBeNull();
    stage(2, W1);
    expect(f.stage()).toEqual(S1);
    expect(seen).toEqual([S1, null, S1, null, S1]);

    // (B) A published zero size, then a valid one: only the latest resize's stage counts.
    f.resize(0, 240, 1);
    expect(view.decode().map((r) => r.seq)).toEqual([3]);
    expect(f.stage()).toBeNull();
    f.resize(800, 240, 1);
    expect(view.decode().map((r) => r.seq)).toEqual([4]);
    stage(3, null);
    stage(2, W1);
    expect(f.stage()).toBeNull();
    stage(4, W1);
    expect(f.stage()).toEqual(S1);
    expect(seen).toEqual([S1, null, S1, null, S1, null, S1]);
  });
});
