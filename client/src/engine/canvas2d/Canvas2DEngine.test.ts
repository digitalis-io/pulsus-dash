import { describe, expect, it, vi } from 'vitest';
import type { FrameData, VisSpec } from '../api';
import { synthLines } from '../../dev/synth';
import {
  harness,
  key,
  LINE_NONE,
  pointer,
  seriesData,
  seriesFrame,
  type Harness,
} from '../../test/engineHarness';
import { colour, seriesPalette, sequentialRamp } from '../../styles/tokens';
import { bucketScale } from './bucketScale';
import { barStats } from './summary';
import { brushSnapUnit } from './columns';
import { Canvas2DEngine, ChartUnsupportedError, MAX_SERIES } from './Canvas2DEngine';

const K = (i: number): string => `00000000000000${i.toString(16).padStart(2, '0')}`;
const STATE = ['ok', 'watch', 'degraded', 'failing', 'unknown'] as const;

function show(
  h: Harness,
  spec: VisSpec,
  data: FrameData,
  w: { fromMs: number; toMs: number },
  size: readonly [number, number, number] = [800, 240, 1],
): void {
  h.frame.setSpec(spec);
  h.frame.setData(data);
  h.frame.setTimeWindow(w);
  h.frame.resize(size[0], size[1], size[2]);
  h.flush();
}

const plotOf = (h: Harness) => {
  const s = h.a11y.at(-1);
  if (s === undefined) throw new Error('no a11y summary');
  return s.plot;
};

describe('unit:series-cap', () => {
  it('draws the first 500 of 600 series and reports the cap', () => {
    const h = harness(Canvas2DEngine);
    const w = { fromMs: 0, toMs: 3_600_000 };
    const series = synthLines({
      seed: 1,
      series: 600,
      points: 60,
      ...w,
      name: 'm',
      base: 10,
      amp: 2,
    });
    show(h, LINE_NONE, seriesData(...series), w);
    const strokes = h.layer().calls('stroke');
    expect(MAX_SERIES).toBe(500);
    expect(strokes).toHaveLength(500);
    for (const s of strokes) expect(seriesPalette.dark).toContain(s.strokeStyle);
    expect(h.a11y.at(-1)).toMatchObject({ seriesShown: 500, seriesTotal: 600, kind: 'line' });
  });
});

describe('engine', () => {
  it('gaps: breaks the path at NaN and draws a lone sample as a dot', () => {
    const h = harness(Canvas2DEngine);
    const vs = [1, 2, NaN, 4, 5, NaN, 7, NaN];
    const s = seriesFrame(
      K(1),
      vs.map((_, i) => i * 100),
      vs,
    );
    show(h, LINE_NONE, seriesData(s), { fromMs: 0, toMs: 800 });
    const ops = h
      .layer()
      .ops.filter((o) => ['moveTo', 'lineTo', 'arc'].includes(o.op))
      .map((o) => o.op);
    expect(ops).toEqual(['moveTo', 'lineTo', 'moveTo', 'lineTo', 'arc']);
  });

  it('DPR: sizes the backing store and scales every draw', () => {
    const h = harness(Canvas2DEngine);
    show(
      h,
      LINE_NONE,
      seriesData(seriesFrame(K(1), [0, 1], [1, 2])),
      { fromMs: 0, toMs: 1 },
      [300, 200, 2],
    );
    expect([h.canvas.width, h.canvas.height]).toEqual([600, 400]);
    expect(h.layer().ops[0]).toMatchObject({ op: 'setTransform', args: [2, 0, 0, 2, 0, 0] });
    expect(h.visible().ops[0]).toMatchObject({ op: 'setTransform', args: [2, 0, 0, 2, 0, 0] });
  });

  it('coalescing: inputs in one tick give one frame and one layer draw', () => {
    const h = harness(Canvas2DEngine);
    h.frame.setSpec(LINE_NONE);
    h.frame.setData(seriesData(seriesFrame(K(1), [0, 1], [1, 2])));
    h.frame.setTimeWindow({ fromMs: 0, toMs: 1 });
    h.frame.setTheme('light');
    h.frame.resize(300, 200, 1);
    expect(h.queued()).toBe(1);
    h.flush();
    expect(h.layer().calls('setTransform')).toHaveLength(1);
  });

  it('theme: draws from the light tokens', () => {
    const h = harness(Canvas2DEngine);
    h.frame.setTheme('light');
    const series = [1, 2, 3].map((i) => seriesFrame(K(i), [0, 1], [i, i + 1]));
    show(h, LINE_NONE, seriesData(...series), { fromMs: 0, toMs: 1 });
    expect(h.layer().calls('fillRect')[0]?.fillStyle).toBe(colour.light['surface-1']);
    const strokes = h.layer().calls('stroke');
    expect(strokes).toHaveLength(3);
    for (const s of strokes) expect(seriesPalette.light).toContain(s.strokeStyle);
  });

  it('bars: stacks by category order and colours by level', () => {
    const h = harness(Canvas2DEngine);
    const spec: VisSpec = {
      kind: 'bars',
      title: 'T',
      unit: { kind: 'none' },
      stacking: 'normal',
      categoryLabel: 'level',
      categoryOrder: ['error', 'warn', 'info', 'debug', 'trace'],
    };
    const ts = [0, 1_000, 2_000];
    const series = ['info', 'error', 'trace', 'warn', 'debug'].map((level, i) =>
      seriesFrame(K(i + 1), ts, [10, 10, 10], { level, service_name: 'checkout' }),
    );
    show(h, spec, seriesData(...series), { fromMs: 0, toMs: 3_000 });
    const palette = new Set<string>(seriesPalette.dark);
    const bars = h
      .layer()
      .calls('fillRect')
      .filter((o) => palette.has(o.fillStyle));
    const x0 = Math.min(...bars.map((o) => Number(o.args[0])));
    const first = bars
      .filter((o) => o.args[0] === x0)
      .sort((a, b) => Number(b.args[1]) - Number(a.args[1]));
    expect(first.map((o) => o.fillStyle)).toEqual(
      [5, 1, 0, 4, 3].map((i) => seriesPalette.dark[i]),
    );
    const state = new Set<string>(STATE.map((s) => colour.dark[s]));
    for (const o of h.layer().ops) {
      expect(state.has(o.fillStyle) && o.op.startsWith('fill')).toBe(false);
      expect(state.has(o.strokeStyle) && o.op === 'stroke').toBe(false);
    }
  });

  it('heatmap: ramp colours, linear rows under the +Inf band, +Inf label and band picking', () => {
    const h = harness(Canvas2DEngine);
    const spec: VisSpec = {
      kind: 'heatmap',
      title: 'T',
      unit: { kind: 'time', base: 'ms' },
      countUnit: { kind: 'none' },
    };
    const data: FrameData = {
      kind: 'heatmap',
      heatmap: {
        timestamps: new Float64Array([0, 1_000]),
        bounds: new Float64Array([5, 10, Infinity]),
        counts: new Float64Array([0, 5, 10, 10, 0, 1]),
      },
    };
    show(h, spec, data, { fromMs: 0, toMs: 2_000 });
    const ramp = sequentialRamp.dark;
    const cells = h
      .layer()
      .calls('fillRect')
      .filter((o) => (ramp as readonly string[]).includes(o.fillStyle));
    expect(cells.map((o) => o.fillStyle).sort()).toEqual(
      [ramp[4], ramp[8], ramp[8], ramp[0]].sort(),
    );
    const plot = plotOf(h);
    const s = bucketScale(new Float64Array([5, 10, Infinity]), plot, 14);
    expect(s.kind).toBe('linear');
    const [r0, r1] = s.rows;
    expect(
      Math.abs((r0?.y0 ?? 0) - (r0?.y1 ?? 0) - ((r1?.y0 ?? 0) - (r1?.y1 ?? 0))),
    ).toBeLessThanOrEqual(0.5);
    expect(s.infBand).not.toBeNull();
    const band = s.infBand ?? { y0: 0, y1: 0 };
    const inf = h
      .layer()
      .calls('fillText')
      .find((o) => o.args[0] === '+Inf');
    expect(Number(inf?.args[2])).toBeCloseTo((band.y0 + band.y1) / 2, 6);
    pointer(h.canvas, 'pointermove', plot.x + plot.width * 0.25, (band.y0 + band.y1) / 2);
    h.flush();
    expect(h.hover.at(-1)?.rows).toEqual([
      { key: '2', name: '> 10 ms', colourIndex: null, value: 10 },
    ]);
  });

  // r4-1: the first bucket of a linear scale whose first bound is ≤ 0 is drawn and pickable.
  it.each([
    [[0, 5, Infinity], '≤ 0 s'],
    [[-5, -1, Infinity], '≤ -5 ms'],
  ])('heatmap %o: the first bucket has a height, a fill and a hover row', (bounds, name) => {
    const h = harness(Canvas2DEngine);
    const spec: VisSpec = {
      kind: 'heatmap',
      title: 'T',
      unit: { kind: 'time', base: 'ms' },
      countUnit: { kind: 'none' },
    };
    const data: FrameData = {
      kind: 'heatmap',
      heatmap: {
        timestamps: new Float64Array([0]),
        bounds: new Float64Array(bounds),
        counts: new Float64Array([4, 1, 2]),
      },
    };
    show(h, spec, data, { fromMs: 0, toMs: 1_000 });
    const plot = plotOf(h);
    const s = bucketScale(new Float64Array(bounds), plot, 14);
    const r0 = s.rows[0];
    if (r0 === undefined) throw new Error('no row 0');
    expect(r0.y0 - r0.y1).toBeGreaterThan(0);
    const cell = h
      .layer()
      .calls('fillRect')
      .find((o) => o.fillStyle === sequentialRamp.dark[8]);
    expect(cell).toBeDefined();
    expect(Number(cell?.args[1])).toBeCloseTo(r0.y1, 6);
    expect(Number(cell?.args[3])).toBeCloseTo(r0.y0 - r0.y1, 6);
    pointer(h.canvas, 'pointermove', plot.x + plot.width / 2, (r0.y0 + r0.y1) / 2);
    h.flush();
    expect(h.hover.at(-1)?.rows).toEqual([{ key: '0', name, colourIndex: null, value: 4 }]);
  });

  it('stat: the formatted value, — for NaN, and the summary', () => {
    const h = harness(Canvas2DEngine);
    const spec: VisSpec = { kind: 'stat', title: 'T', unit: { kind: 'time', base: 'ms' } };
    show(
      h,
      spec,
      { kind: 'scalar', scalar: { value: 2843, timestampMs: 0 } },
      { fromMs: 0, toMs: 1 },
    );
    expect(
      h
        .layer()
        .calls('fillText')
        .map((o) => o.args[0]),
    ).toEqual(['2.84 s']);
    expect(h.a11y.at(-1)).toMatchObject({
      min: 2843,
      max: 2843,
      last: 2843,
      seriesTotal: 1,
      seriesShown: 1,
    });
    h.frame.setData({ kind: 'scalar', scalar: { value: NaN, timestampMs: 0 } });
    h.layer().clearOps();
    h.flush();
    expect(
      h
        .layer()
        .calls('fillText')
        .map((o) => o.args[0]),
    ).toEqual(['—']);
  });

  it('hover: snaps to the nearest sample and reports every series', () => {
    const h = harness(Canvas2DEngine);
    const t0 = 1_000_000;
    const ts = Array.from({ length: 10 }, (_, i) => t0 + i * 1_000);
    const series = [1, 2, 3].map((j) =>
      seriesFrame(
        K(j),
        ts,
        ts.map((_, i) => j * 100 + i),
      ),
    );
    show(h, LINE_NONE, seriesData(...series), { fromMs: t0, toMs: t0 + 9_000 });
    const plot = plotOf(h);
    const x = plot.x + (4_300 / 9_000) * plot.width;
    pointer(h.canvas, 'pointermove', x, plot.y + 10);
    pointer(h.canvas, 'pointermove', x, plot.y + 11);
    h.flush();
    expect(h.hover).toHaveLength(1);
    expect(h.hover[0]?.tMs).toBe(t0 + 4_000);
    expect(h.hover[0]?.source).toBe('pointer');
    expect(h.hover[0]?.rows.map((r) => r.value)).toEqual([104, 204, 304]);
    pointer(h.canvas, 'pointermove', plot.x - 5, plot.y + 10);
    h.flush();
    expect(h.hover.at(-1)).toBeNull();
  });

  it('brush: snaps the dragged window, ignores short drags, zooms out on double-click', () => {
    const h = harness(Canvas2DEngine);
    const from = Date.UTC(2026, 10, 19, 12);
    const to = Date.UTC(2026, 10, 19, 13);
    const data = seriesData(seriesFrame(K(1), [from, to], [1, 2]));
    show(h, LINE_NONE, data, { fromMs: from, toMs: to }, [1_100, 240, 1]);
    const p0 = plotOf(h);
    h.frame.resize(1_100 + 1_000 - p0.width, 240, 1);
    h.flush();
    const plot = plotOf(h);
    expect(plot.width).toBe(1_000);
    expect(brushSnapUnit(3_600)).toBe(15_000);
    expect(brushSnapUnit(100)).toBe(1_000);
    expect(brushSnapUnit(300)).toBe(5_000);
    const x = (ms: number): number => plot.x + ((ms - from) / (to - from)) * plot.width;
    const y = plot.y + plot.height / 2;
    pointer(h.canvas, 'pointerdown', x(from + 20 * 60_000 + 1_200), y, { buttons: 1 });
    pointer(h.canvas, 'pointermove', x(from + 22 * 60_000), y, { buttons: 1 });
    pointer(h.canvas, 'pointerup', x(from + 24 * 60_000 + 58_900), y);
    h.flush();
    expect(h.brush).toEqual([
      { fromMs: from + 20 * 60_000, toMs: from + 25 * 60_000, gesture: 'drag' },
    ]);
    pointer(h.canvas, 'pointerdown', 500, y, { buttons: 1 });
    pointer(h.canvas, 'pointerup', 503, y);
    h.flush();
    expect(h.brush).toHaveLength(1);
    pointer(h.canvas, 'dblclick', x(from + 30 * 60_000), y);
    expect(h.brush.at(-1)).toEqual({
      fromMs: from - 30 * 60_000,
      toMs: to + 30 * 60_000,
      gesture: 'zoomOut',
    });
  });

  it('keyboard: moves the crosshair index and prevents the default', () => {
    const target = document.createElement('div');
    const h = harness(Canvas2DEngine, { keyTarget: target });
    const ts = Array.from({ length: 10 }, (_, i) => i * 1_000);
    show(h, LINE_NONE, seriesData(seriesFrame(K(1), ts, ts)), { fromMs: 0, toMs: 9_000 });
    const index = (): number | null => {
      const last = h.hover.at(-1);
      return last === null || last === undefined ? null : last.tMs / 1_000;
    };
    const seen: (number | null)[] = [];
    for (const k of [
      'ArrowRight',
      'ArrowRight',
      'End',
      'PageDown',
      'PageUp',
      'ArrowLeft',
      'Home',
      'Escape',
      'ArrowLeft',
    ]) {
      const e = key(target, k);
      expect(e.defaultPrevented, k).toBe(true);
      h.flush();
      seen.push(index());
    }
    expect(seen).toEqual([0, 1, 9, 0, 9, 8, 0, null, 9]);
    expect(h.hover.at(-1)?.source).toBe('keyboard');
    const n = h.hover.length;
    const ctrl = key(target, 'ArrowRight', { ctrlKey: true });
    h.flush();
    expect(ctrl.defaultPrevented).toBe(false);
    expect(h.hover).toHaveLength(n);
  });

  it('dispose: removes listeners, cancels the frame and ignores later calls', () => {
    const target = document.createElement('div');
    const h = harness(Canvas2DEngine, { keyTarget: target });
    show(h, LINE_NONE, seriesData(seriesFrame(K(1), [0, 1], [1, 2])), { fromMs: 0, toMs: 1 });
    const onCanvas = vi.spyOn(h.canvas, 'removeEventListener');
    const onTarget = vi.spyOn(target, 'removeEventListener');
    const a11y = h.a11y.length;
    h.frame.setData(seriesData(seriesFrame(K(1), [0, 1], [3, 4])));
    expect(h.queued()).toBe(1);
    h.frame.dispose();
    expect(h.queued()).toBe(0);
    expect(onCanvas).toHaveBeenCalledTimes(6);
    expect(onTarget).toHaveBeenCalledTimes(2);
    expect(h.canvas.width).toBe(0);
    h.layer().clearOps();
    expect(() => {
      h.frame.setData(seriesData(seriesFrame(K(1), [0, 1], [5, 6])));
      h.frame.resize(10, 10, 1);
    }).not.toThrow();
    expect(h.queued()).toBe(0);
    h.flush();
    expect(h.layer().ops).toHaveLength(0);
    expect(h.a11y).toHaveLength(a11y);
  });

  it('unsupported: no 2D context throws ChartUnsupportedError', () => {
    const engine = new Canvas2DEngine({ contextOf: () => null, fonts: null });
    expect(() =>
      engine.createFrame(document.createElement('canvas'), { timeZone: 'UTC', keyTarget: null }),
    ).toThrow(ChartUnsupportedError);
  });
});

describe('unit:drawn and frame id (#90, ADR-0019)', () => {
  const data = seriesData(seriesFrame(K(1), [0, 1, 2], [1, 2, 3]));
  const w = { fromMs: 0, toMs: 2 };

  it('unit:drawn after each draw', () => {
    const h = harness(Canvas2DEngine, { id: 'f9' });
    show(h, LINE_NONE, data, w, [800, 240, 1]);
    expect(h.drawn).toEqual([{ cssWidth: 800, cssHeight: 240, dpr: 1 }]);
    const plot = plotOf(h);
    pointer(h.canvas, 'pointermove', plot.x + plot.width / 2, plot.y + 10);
    h.flush();
    expect(h.drawn).toHaveLength(2);
    h.frame.resize(0, 0, 1);
    h.flush();
    expect(h.drawn).toHaveLength(2);
    h.frame.dispose();
    h.frame.setData(data);
    h.flush();
    expect(h.drawn).toHaveLength(2);
  });

  it('unit:chart-draw carries the frame id', () => {
    const measure = vi.spyOn(performance, 'measure');
    try {
      const h = harness(Canvas2DEngine, { id: 'f9' });
      show(h, LINE_NONE, data, w);
      const detailOf = () =>
        (
          measure.mock.calls.filter((c) => c[0] === 'chart-draw').at(-1)?.[1] as
            { detail?: unknown } | undefined
        )?.detail;
      expect(detailOf()).toEqual({ kind: 'line', series: 1, frame: 'f9' });
      const plain = harness(Canvas2DEngine);
      show(plain, LINE_NONE, data, w);
      expect(detailOf()).toEqual({ kind: 'line', series: 1, frame: null });
    } finally {
      measure.mockRestore();
    }
  });

  it('unit:a kind change clears the canvas', () => {
    const h = harness(Canvas2DEngine, { id: 'f9' });
    show(h, LINE_NONE, data, w);
    const clears = () =>
      h
        .visible()
        .calls('clearRect')
        .map((o) => o.args);
    // The same kind (a title change) keeps the drawn image until the redraw.
    h.frame.setSpec({ ...LINE_NONE, title: 'U' });
    expect(clears()).toHaveLength(0);
    h.flush();
    h.frame.setSpec({
      kind: 'bars',
      title: 'U',
      unit: { kind: 'none' },
      stacking: 'normal',
      categoryLabel: 'level',
      categoryOrder: [],
    });
    expect(clears()).toEqual([[0, 0, 800, 240]]);
  });
});

describe('large inputs', () => {
  // More buckets than the JavaScript engine's argument limit: extrema are computed without a spread.
  it('renders and summarises 200 000 bar buckets without throwing', () => {
    const n = 200_000;
    const ts = Array.from({ length: n }, (_, i) => i * 1_000);
    const vs = ts.map((_, i) => (i % 100) + 1);
    const s = seriesFrame(K(1), ts, vs, { level: 'info' });
    expect(barStats([s])).toEqual({ min: 1, max: 100, last: 100 });
    const h = harness(Canvas2DEngine);
    const spec: VisSpec = {
      kind: 'bars',
      title: 'T',
      unit: { kind: 'none' },
      stacking: 'normal',
      categoryLabel: 'level',
      categoryOrder: ['info'],
    };
    expect(() => {
      show(h, spec, seriesData(s), { fromMs: 0, toMs: n * 1_000 });
    }).not.toThrow();
    expect(h.a11y.at(-1)).toMatchObject({ kind: 'bars', min: 1, max: 100, last: 100 });
    expect(h.layer().calls('fillRect').length).toBeGreaterThan(1);
  });
});

describe('bucket overlapping the window edge (merged path)', () => {
  // 3 000 one-second buckets (more than CSS px, so they are merged); value/count i + 1.
  const n = 3_000;
  const ts = Array.from({ length: n }, (_, i) => i * 1_000);
  const BARS: VisSpec = {
    kind: 'bars',
    title: 'T',
    unit: { kind: 'none' },
    stacking: 'normal',
    categoryLabel: 'level',
    categoryOrder: ['info'],
  };
  const HEAT: VisSpec = {
    kind: 'heatmap',
    title: 'T',
    unit: { kind: 'none' },
    countUnit: { kind: 'none' },
  };
  const bars = seriesData(
    seriesFrame(
      K(1),
      ts,
      ts.map((_, i) => i + 1),
      { level: 'info' },
    ),
  );
  const heat: FrameData = {
    kind: 'heatmap',
    heatmap: {
      timestamps: new Float64Array(ts),
      bounds: new Float64Array([1]),
      counts: new Float64Array(ts.map((_, i) => i + 1)),
    },
  };
  const marks = (h: Harness, colours: readonly string[]) =>
    h
      .layer()
      .calls('fillRect')
      .filter((o) => colours.includes(o.fillStyle))
      .map((o) => ({ x: Number(o.args[0]), w: Number(o.args[2]) }));

  it.each([
    ['bars', BARS, bars, seriesPalette.dark],
    ['heatmap', HEAT, heat, sequentialRamp.dark],
  ] as const)(
    '%s: a bucket starting before the window covers the left edge',
    (_k, spec, data, colours) => {
      const h = harness(Canvas2DEngine);
      // Bucket 100 spans 100–101 s; the window 100.2–100.8 s lies inside it.
      show(h, spec, data, { fromMs: 100_200, toMs: 100_800 });
      const plot = plotOf(h);
      const m = marks(h, colours);
      expect(m).toHaveLength(1);
      expect(m[0]?.x).toBe(plot.x);
      expect((m[0]?.x ?? 0) + (m[0]?.w ?? 0)).toBeGreaterThanOrEqual(plot.x + plot.width - 1);
    },
  );

  it.each([
    ['bars', BARS, bars, seriesPalette.dark],
    ['heatmap', HEAT, heat, sequentialRamp.dark],
  ] as const)(
    '%s: a bucket running past the window end reaches the right edge',
    (_k, spec, data, colours) => {
      const h = harness(Canvas2DEngine);
      show(h, spec, data, { fromMs: 100_200, toMs: 101_500 });
      const plot = plotOf(h);
      const m = marks(h, colours).sort((a, b) => a.x - b.x);
      expect(m).toHaveLength(2);
      expect(m[0]?.x).toBe(plot.x);
      const last = m.at(-1) ?? { x: 0, w: 0 };
      expect(last.x + last.w).toBeGreaterThanOrEqual(plot.x + plot.width - 1);
    },
  );
});

describe('heatmap missing cells (plan #63 §4.3.1)', () => {
  const HEAT: VisSpec = {
    kind: 'heatmap',
    title: 'T',
    unit: { kind: 'none' },
    countUnit: { kind: 'none' },
  };
  const ramp: readonly string[] = sequentialRamp.dark;
  const rows = (h: Harness) =>
    (h.hover.at(-1)?.rows ?? []).map((r) => ({ key: r.key, value: r.value }));

  it('Canvas2DEngine heatmap missing cells: no fill, no hover row, skipped in the summary', () => {
    const h = harness(Canvas2DEngine);
    const data: FrameData = {
      kind: 'heatmap',
      heatmap: {
        timestamps: new Float64Array([0, 1000]),
        bounds: new Float64Array([1, Infinity]),
        counts: new Float64Array([NaN, NaN, 4, 2]),
      },
    };
    show(h, HEAT, data, { fromMs: 0, toMs: 2000 });
    const fills = h
      .layer()
      .calls('fillRect')
      .filter((o) => ramp.includes(o.fillStyle))
      .map((o) => o.fillStyle);
    expect(fills.sort()).toEqual([ramp[4], ramp[8]].sort());
    const plot = plotOf(h);
    const band = bucketScale(new Float64Array([1, Infinity]), plot, 14).infBand ?? { y0: 0, y1: 0 };
    pointer(h.canvas, 'pointermove', plot.x + plot.width * 0.25, (band.y0 + band.y1) / 2);
    h.flush();
    expect(rows(h)).toEqual([]);
    pointer(h.canvas, 'pointermove', plot.x + plot.width * 0.75, (band.y0 + band.y1) / 2);
    h.flush();
    expect(rows(h)).toEqual([{ key: '1', value: 2 }]);
    expect(h.a11y.at(-1)).toMatchObject({ min: 2, max: 4, last: 6 });
  });

  it('Canvas2DEngine heatmap compressed missing: a merged cell with a missing bucket is not drawn', () => {
    const target = document.createElement('div');
    const h = harness(Canvas2DEngine, { keyTarget: target });
    const n = 2000;
    const counts = new Float64Array(2 * n);
    for (let i = 0; i < n; i++) {
      counts[2 * i] = i % 2 === 1 && i < 1000 ? NaN : 4;
      counts[2 * i + 1] = 2;
    }
    const bounds = new Float64Array([1, Infinity]);
    const data: FrameData = {
      kind: 'heatmap',
      heatmap: {
        timestamps: new Float64Array(Array.from({ length: n }, (_, i) => i * 1000)),
        bounds,
        counts,
      },
    };
    show(h, HEAT, data, { fromMs: 0, toMs: 2_000_000 }, [800, 240, 1]);
    const plot = plotOf(h);
    expect(n).toBeGreaterThan(Math.floor(plot.width));
    const scale = bucketScale(bounds, plot, 14);
    const row0 = scale.rows[0];
    const inf = scale.infBand;
    if (row0 === undefined || inf === null) throw new Error('no bands');
    const fills = h
      .layer()
      .calls('fillRect')
      .filter((o) => ramp.includes(o.fillStyle));
    const inRow0 = fills.filter((o) => Math.abs(Number(o.args[1]) - row0.y1) < 1e-6);
    const inInf = fills.filter((o) => Math.abs(Number(o.args[1]) - inf.y0) < 1e-6);
    // (1) Row 0 is drawn only where no merged bucket is missing: the right half.
    expect(inRow0.length).toBeGreaterThanOrEqual(1);
    const mid = Math.round(plot.x + plot.width / 2) - 1;
    expect(inRow0.filter((o) => Number(o.args[0]) < mid).map((o) => Number(o.args[0]))).toEqual([]);
    // (2) The +Inf row has no missing bucket and starts at the left edge.
    expect(inInf.some((o) => Number(o.args[0]) === plot.x)).toBe(true);
    // (3) Keyboard hover lists the raw buckets, never a merged sum.
    key(target, 'ArrowRight');
    h.flush();
    expect(rows(h)).toEqual([
      { key: '1', value: 2 },
      { key: '0', value: 4 },
    ]);
    key(target, 'ArrowRight');
    h.flush();
    expect(rows(h)).toEqual([{ key: '1', value: 2 }]);
    // (4) The summary reads the raw cells.
    expect(h.a11y.at(-1)).toMatchObject({ max: 4 });
  });
});
