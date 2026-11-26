/**
 * The main-thread side of an engine frame (plan #68 C1 §3.5; C2a1 §4.4; ADR-0019, D-PROTO): spec,
 * data, theme and dispose are messages; the camera and the size go through the input ring, held
 * until the worker reports the frame `created`; `drawn` is reported only for the latest `resize()`
 * call, with the caller's values, once no Resize is held or unpublished.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventMarker, FrameData, VisSpec } from '../api';
import { CB, memory, RingView } from '../../test/ringView';
import {
  WasmFrame,
  type CameraState,
  type EngineFrame,
  type FrameRing,
  type OverlayState,
  type StageModel,
} from './frame';
import type { MainToRender, StageWire } from './protocol';
import { InputRing } from './ring';

const S: VisSpec = { kind: 'line', title: 'T', unit: { kind: 'none' } };
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
const OVERLAY = 0x24;
const SELECT = 0x25;
const CODES = { camera: CAMERA, resize: RESIZE, overlay: OVERLAY, select: SELECT } as const;

function port() {
  const sent: { msg: MainToRender; transfer: Transferable[] }[] = [];
  return {
    sent,
    postMessage(msg: MainToRender, transfer: Transferable[] = []): void {
      sent.push({ msg, transfer });
    },
  };
}

type Arg = CameraState | OverlayState | readonly number[];
type Kind = 'camera' | 'resize' | 'overlay' | 'select';

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
  overlay(frame: number, o: OverlayState): void {
    this.put('overlay', frame, o);
  }
  select(frame: number, x: number, y: number): void {
    this.put('select', frame, [x, y]);
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
  private n = 0;
  private put(kind: Kind, frame: number, arg: Arg): void {
    // Select is discrete: never coalesced (plan #68 C2b §3.1).
    const k = `${kind}:${String(frame)}${kind === 'select' ? `:${String(this.n++)}` : ''}`;
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
    this.cbs.get(frame)?.(CODES[kind], seq);
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
    f.setCamera({ view: { lo: 0, hi: 10 }, value: null, band: null });
    f.setTheme('dark');
    // Through the seam's signatures: the events go as their times (plan #68 C2c1); the selection
    // as its keys and interval (C2c2), the first call always.
    const seam: EngineFrame = f;
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
      { t: 'events', id: 1, atMs: new Float64Array([]) },
      { t: 'selection', id: 1, keys: [], fromMs: null, toMs: null },
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
    // The camera is the controller's (plan #68 C2a2): the frame sends what it is given.
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

/** Fills the ring with Resize records of a frame no test frame uses, until one waits. */
function fill(ring: InputRing): void {
  for (let i = 0; i < 2000 && ring.unpublished(99) === 0; i++) ring.resize(99, 10 + i, 10, 1);
  ring.drop(99);
}

describe('WasmFrame stage (plan #68 C2a2 §3.3)', () => {
  const W1: StageWire = {
    plot: { x: 50, y: 8, width: 742, height: 200 },
    domain: { min: 0, max: 30 },
    labelW: 38,
    pickCount: 0,
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

describe('WasmFrame hover and select (plan #68 C2b §4.2)', () => {
  const ROW = { key: '00000000000000a1', name: '{}', colourIndex: 1, value: 9 };
  const H = { source: 'pointer' as const, tMs: 1080, xCss: 300, yCss: 100, rows: [ROW] };
  const P = { hover: { kind: 'pointer' as const, x: 300, y: 100 }, box: null };

  it('wasm frame hover: only the latest Overlay’s hover; select answered; pickCount read', () => {
    const m = memory();
    const view = new RingView(m);
    const ring = new InputRing(m, CB, () => undefined);
    const { f } = frame();
    const hovers: unknown[] = [];
    const selects: unknown[] = [];
    f.on('hover', (h) => hovers.push(h));
    f.on('select', (s) => selects.push(s));
    // Before `created`: a select is dropped, the latest Overlay held.
    f.select(1, 2);
    f.setOverlay({ hover: { kind: 'key', index: 0 }, box: null });
    f.setOverlay(P);
    f.created(ring);
    const held = view.decode();
    expect(held.map((r) => [r.kind, r.seq])).toEqual([[OVERLAY, 1]]);
    expect(held[0]?.f.slice(0, 2)).toEqual([300, 100]);
    const hover = (oseq: number, ev: typeof H | null): void => {
      f.handle({ t: 'hover', id: 1, oseq, ev });
    };
    hover(1, H);
    expect(hovers).toEqual([H]);
    // A newer Overlay published as s: s − 1's hover is stale.
    f.setOverlay({ hover: { kind: 'pointer', x: 310, y: 100 }, box: null });
    expect(view.decode().map((r) => r.seq)).toEqual([2]);
    hover(1, H);
    expect(hovers).toEqual([H]);
    hover(2, null);
    expect(hovers).toEqual([H, null]);
    // An Overlay waiting in a full ring: no hover counts, not even its predecessor's.
    fill(ring);
    f.setOverlay(P);
    hover(2, H);
    expect(hovers).toEqual([H, null]);
    view.decode();
    ring.flush();
    expect(view.decode().map((r) => [r.kind, r.seq])).toEqual([[OVERLAY, 3]]);
    hover(3, H);
    expect(hovers).toEqual([H, null, H]);
    // Any later record moves the frame's seq, not its Overlay: the Overlay's hover still counts.
    f.setCamera({ view: { lo: 0, hi: 1 }, value: null, band: null });
    hover(3, null);
    expect(hovers).toEqual([H, null, H, null]);
    // A select goes to the ring; its answer is forwarded, whatever was published since.
    f.select(12.5, 40);
    const sel = view.decode().filter((r) => r.kind === SELECT);
    expect(sel.map((r) => [r.frame, r.f[0], r.f[1]])).toEqual([[1, 12.5, 40]]);
    const item = { kind: 'point' as const, key: ROW.key, tMs: 1080, value: 9 };
    f.handle({ t: 'select', id: 1, item });
    f.handle({ t: 'select', id: 1, item: null });
    expect(selects).toEqual([
      { source: 'pointer', item },
      { source: 'pointer', item: null },
    ]);
    // The stage's pickCount comes from the wire.
    f.resize(800, 240, 1);
    const rseq = view.decode().at(-1)?.seq ?? 0;
    f.handle({
      t: 'stage',
      id: 1,
      rseq,
      stage: {
        plot: { x: 50, y: 8, width: 742, height: 200 },
        domain: null,
        labelW: 38,
        pickCount: 61,
      },
    });
    expect(f.stage()?.pickCount).toBe(61);
  });
});

describe('WasmFrame events (plan #68 C2c1 §3.3)', () => {
  const at = (id: string, atMs: number): EventMarker => ({
    id,
    atMs,
    endMs: null,
    kind: 'deploy',
    title: id,
  });

  it('wasm frame events: each new array posts its times in call order, NaN kept', () => {
    const { f, p } = frame();
    const a = at('a', 20);
    const b = at('b', NaN);
    const e = [a, b];
    f.setEvents(e);
    const events = (): unknown[] => p.sent.map((s) => s.msg).filter((m) => m.t === 'events');
    expect(events()).toEqual([{ t: 'events', id: 1, atMs: new Float64Array([20, NaN]) }]);
    const sent = events()[0] as { atMs: Float64Array };
    expect(sent.atMs).toBeInstanceOf(Float64Array);
    expect(Number.isNaN(sent.atMs[1])).toBe(true);
    // The same array again: nothing.
    f.setEvents(e);
    expect(events()).toHaveLength(1);
    // An equal but new array, then none: each is sent.
    f.setEvents([a, b]);
    f.setEvents([]);
    expect(events()).toEqual([
      { t: 'events', id: 1, atMs: new Float64Array([20, NaN]) },
      { t: 'events', id: 1, atMs: new Float64Array([20, NaN]) },
      { t: 'events', id: 1, atMs: new Float64Array([]) },
    ]);
    // Nothing after dispose.
    f.dispose();
    f.setEvents([a]);
    expect(events()).toHaveLength(3);
  });
});

describe('WasmFrame selection (plan #68 C2c2 §3.1)', () => {
  it('wasm frame selection: posts keys and interval; an equal copy and a repeated null post nothing', () => {
    const { f, p } = frame();
    const sel = (): unknown[] => p.sent.map((s) => s.msg).filter((m) => m.t === 'selection');
    const k = '00000000000000a1';
    f.setSelection({ keys: [k], fromMs: 1, toMs: 2 });
    expect(sel()).toEqual([{ t: 'selection', id: 1, keys: [k], fromMs: 1, toMs: 2 }]);
    // An equal copy: nothing.
    f.setSelection({ keys: [k], fromMs: 1, toMs: 2 });
    expect(sel()).toHaveLength(1);
    f.setSelection(null);
    expect(sel()).toEqual([
      { t: 'selection', id: 1, keys: [k], fromMs: 1, toMs: 2 },
      { t: 'selection', id: 1, keys: [], fromMs: null, toMs: null },
    ]);
    f.setSelection(null);
    expect(sel()).toHaveLength(2);
    // Nothing after dispose.
    f.dispose();
    f.setSelection({ keys: [k], fromMs: null, toMs: null });
    expect(sel()).toHaveLength(2);
  });
});
