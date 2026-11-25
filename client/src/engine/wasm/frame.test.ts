import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChartFrame, FrameData, VisSpec } from '../api';
import { WasmFrame } from './frame';
import type { MainToRender } from './protocol';

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

function port() {
  const sent: { msg: MainToRender; transfer: Transferable[] }[] = [];
  return {
    sent,
    postMessage(msg: MainToRender, transfer: Transferable[] = []): void {
      sent.push({ msg, transfer });
    },
  };
}

const drawn = (w: number, startMs = 5) =>
  ({
    t: 'drawn',
    id: 1,
    ev: { cssWidth: w, cssHeight: 150, dpr: 2 },
    startMs,
    endMs: startMs + 2,
    series: 1,
  }) as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('WasmFrame (ADR-0019, D-PROTO)', () => {
  it('posts each call as one message and reports drawn at the last size only', () => {
    const p = port();
    const canvas = { width: 0, height: 0 } as unknown as OffscreenCanvas;
    const onFail = vi.fn();
    const f = new WasmFrame(p, 1, canvas, { timeZone: 'UTC', keyTarget: null, id: 'f1' }, onFail);
    const measure = vi.spyOn(performance, 'measure');
    const got = vi.fn();
    f.on('drawn', got);
    f.setSpec(S);
    f.setData(SERIES);
    f.setTimeWindow({ fromMs: 0, toMs: 10 });
    f.setTheme('dark');
    // Through the seam's signatures: kept by the routing frame, not sent (C2).
    const seam: ChartFrame = f;
    seam.setEvents([]);
    seam.setSelection(null);
    f.resize(300, 150, 2);
    f.handle(drawn(300));
    f.handle(drawn(200));
    f.setData(HEAT);
    f.dispose();
    f.handle(drawn(300, 9));
    f.handle({ t: 'failed', id: 1, reason: 'readback' });
    f.setSpec(S);
    expect(p.sent.map((s) => s.msg)).toEqual([
      { t: 'create', id: 1, canvas, frameId: 'f1' },
      { t: 'spec', id: 1, json: JSON.stringify(S) },
      {
        t: 'data',
        id: 1,
        series: [{ key: '00000000000000aa', names: ['job'], values: ['api'], t: T, v: V }],
      },
      { t: 'window', id: 1, from: 0, to: 10 },
      { t: 'theme', id: 1, theme: 0 },
      { t: 'resize', id: 1, w: 300, h: 150, dpr: 2 },
      { t: 'data', id: 1, series: null },
      { t: 'dispose', id: 1 },
    ]);
    // Only the canvas is transferred; the data arrays stay with the caller (cloned).
    expect(p.sent[0]?.transfer).toEqual([canvas]);
    expect(p.sent.slice(1).every((s) => s.transfer.length === 0)).toBe(true);
    expect([T.length, V.length]).toEqual([2, 2]);
    expect(got.mock.calls).toEqual([[{ cssWidth: 300, cssHeight: 150, dpr: 2 }]]);
    const m = measure.mock.calls.filter((c) => c[0] === 'chart-draw');
    expect(m.map((c) => c[1])).toEqual([
      { start: 5, end: 7, detail: { kind: 'line', series: 1, frame: 'f1' } },
    ]);
    expect(onFail).not.toHaveBeenCalled();
  });

  it('a11y and failed reach the frame; drawn is never at size 0', () => {
    const p = port();
    const onFail = vi.fn();
    const f = new WasmFrame(
      p,
      1,
      {} as OffscreenCanvas,
      { timeZone: 'UTC', keyTarget: null },
      onFail,
    );
    const got = vi.fn();
    const a11y = vi.fn();
    f.on('drawn', got);
    f.on('a11y', a11y);
    f.resize(0, 150, 1);
    f.handle({ ...drawn(0), ev: { cssWidth: 0, cssHeight: 150, dpr: 1 } });
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
