import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChartFrame, FrameData, VisSpec } from '../api';
import { WasmFrame } from './frame';
import type { MainToRender } from './protocol';

const LINE: VisSpec = { kind: 'line', title: 'T', unit: { kind: 'none' } };
const T = new Float64Array([1, 2]);
const V = new Float64Array([3, 4]);
const SERIES: FrameData = {
  kind: 'series',
  series: [
    { key: '00000000000000a1', labels: { job: 'api', pod: 'p1' }, timestamps: T, values: V },
  ],
};
const HEAT: FrameData = {
  kind: 'heatmap',
  heatmap: {
    timestamps: new Float64Array([1]),
    bounds: new Float64Array([1]),
    counts: new Float64Array([1]),
  },
};

function port() {
  const sent: { msg: MainToRender; transfer: Transferable[] }[] = [];
  return {
    sent,
    postMessage(msg: MainToRender, transfer: Transferable[] = []): void {
      sent.push({ msg, transfer });
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('WasmFrame (ADR-0019, D-PROTO)', () => {
  it('posts each call as one message and filters drawn to the last size', () => {
    const p = port();
    const canvas = { width: 0, height: 0 } as unknown as OffscreenCanvas;
    const onFail = vi.fn();
    const f = new WasmFrame(p, 3, canvas, { timeZone: 'UTC', keyTarget: null, id: 'f1' }, onFail);
    f.setSpec(LINE);
    f.setData(SERIES);
    f.setData(HEAT);
    f.setTimeWindow({ fromMs: 10, toMs: 20 });
    f.setTheme('light');
    f.setTheme('dark');
    // Through the seam's signatures: kept by the routing frame, not sent (C2).
    const seam: ChartFrame = f;
    seam.setEvents([]);
    seam.setSelection(null);
    f.resize(300, 150, 2);
    expect(p.sent.map((s) => s.msg)).toEqual([
      { t: 'create', id: 3, canvas, frameId: 'f1' },
      { t: 'spec', id: 3, json: JSON.stringify(LINE) },
      {
        t: 'data',
        id: 3,
        series: [
          { key: '00000000000000a1', names: ['job', 'pod'], values: ['api', 'p1'], t: T, v: V },
        ],
      },
      { t: 'data', id: 3, series: null },
      { t: 'window', id: 3, from: 10, to: 20 },
      { t: 'theme', id: 3, theme: 1 },
      { t: 'theme', id: 3, theme: 0 },
      { t: 'resize', id: 3, w: 300, h: 150, dpr: 2 },
    ]);
    // Only the canvas is transferred; the data arrays stay with the caller (cloned).
    expect(p.sent[0]?.transfer).toEqual([canvas]);
    expect(p.sent.slice(1).every((s) => s.transfer.length === 0)).toBe(true);
    expect([T.length, V.length]).toEqual([2, 2]);

    const measure = vi.spyOn(performance, 'measure');
    const drawn = vi.fn();
    const a11y = vi.fn();
    f.on('drawn', drawn);
    f.on('a11y', a11y);
    f.handle({
      t: 'drawn',
      id: 3,
      ev: { cssWidth: 200, cssHeight: 150, dpr: 2 },
      startMs: 1,
      endMs: 2,
      series: 50,
    });
    expect(drawn).not.toHaveBeenCalled();
    f.handle({
      t: 'drawn',
      id: 3,
      ev: { cssWidth: 300, cssHeight: 150, dpr: 2 },
      startMs: 5,
      endMs: 7,
      series: 50,
    });
    expect(drawn).toHaveBeenCalledWith({ cssWidth: 300, cssHeight: 150, dpr: 2 });
    const m = measure.mock.calls.filter((c) => c[0] === 'chart-draw');
    expect(m).toHaveLength(1);
    expect(m[0]?.[1]).toEqual({
      start: 5,
      end: 7,
      detail: { kind: 'line', series: 50, frame: 'f1' },
    });
    const summary = {
      kind: 'line',
      seriesTotal: 1,
      seriesShown: 1,
      fromMs: 10,
      toMs: 20,
      min: 3,
      max: 4,
      last: 4,
      plot: { x: 0, y: 0, width: 300, height: 150 },
      valueAxis: { min: 0, max: 5, manual: false },
      thresholdLabels: [],
      eventLabels: [],
    } as const;
    f.handle({ t: 'a11y', id: 3, ev: summary });
    expect(a11y).toHaveBeenCalledWith(summary);
    f.handle({ t: 'failed', id: 3, reason: 'surface' });
    expect(onFail).toHaveBeenCalledWith('surface');

    f.dispose();
    expect(p.sent.at(-1)?.msg).toEqual({ t: 'dispose', id: 3 });
    const n = p.sent.length;
    f.setSpec(LINE);
    f.handle({
      t: 'drawn',
      id: 3,
      ev: { cssWidth: 300, cssHeight: 150, dpr: 2 },
      startMs: 8,
      endMs: 9,
      series: 50,
    });
    f.handle({ t: 'failed', id: 3, reason: 'readback' });
    expect(p.sent).toHaveLength(n);
    expect(drawn).toHaveBeenCalledTimes(1);
    expect(onFail).toHaveBeenCalledTimes(1);
  });

  it('never reports a drawn at size 0', () => {
    const p = port();
    const f = new WasmFrame(
      p,
      1,
      {} as OffscreenCanvas,
      { timeZone: 'UTC', keyTarget: null },
      () => undefined,
    );
    const drawn = vi.fn();
    f.on('drawn', drawn);
    f.resize(0, 150, 1);
    f.handle({
      t: 'drawn',
      id: 1,
      ev: { cssWidth: 0, cssHeight: 150, dpr: 1 },
      startMs: 1,
      endMs: 2,
      series: 1,
    });
    expect(drawn).not.toHaveBeenCalled();
  });
});
