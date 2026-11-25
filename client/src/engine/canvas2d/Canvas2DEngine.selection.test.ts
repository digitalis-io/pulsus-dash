// unit:selection-draw (T02-025, T25-006, ADR-0025, plan #192 §4.3, §5): the selection drawn in the
// layer pass.
import { describe, expect, it } from 'vitest';
import { size } from '../../styles/tokens';
import type { FrameData, FrameSelection, VisSpec } from '../api';
import { harness, seriesData, seriesFrame, type Harness } from '../../test/engineHarness';
import { last, xOf } from '../../test/cameraKit';
import type { RecordedOp } from '../../test/recordingContext';
import { Canvas2DEngine } from './Canvas2DEngine';
import { seriesColourIndex, themeColours } from './palette';

const K1 = '00000000000000a1';
const K2 = '00000000000000a2';
const W = { fromMs: 0, toMs: 60_000 };
const NONE = { kind: 'none' } as const;
const C = themeColours('dark');
const colourOf = (key: string): string => C.series[seriesColourIndex({ key, labels: {} })] ?? '';
const ts = Array.from({ length: 61 }, (_, i) => i * 1_000);

function frame(spec: VisSpec, data: FrameData, dpr = 1): Harness {
  const h = harness(Canvas2DEngine);
  h.frame.setSpec(spec);
  h.frame.setData(data);
  h.frame.setTimeWindow(W);
  h.frame.resize(400, 200, dpr);
  h.flush();
  return h;
}

/** The layer's ops for `sel` (cleared before). */
function drawWith(h: Harness, sel: FrameSelection | null): RecordedOp[] {
  h.layer().clearOps();
  h.frame.setSelection(sel);
  h.flush();
  return [...h.layer().ops];
}

/** The layer's ops of a fresh frame with no selection ever set. */
function plain(spec: VisSpec, data: FrameData): RecordedOp[] {
  const h = frame(spec, data);
  h.layer().clearOps();
  h.frame.setData(data);
  h.flush();
  return [...h.layer().ops];
}

const LINE: VisSpec = { kind: 'line', title: 'T', unit: NONE };
const LINES = seriesData(
  seriesFrame(
    K1,
    ts,
    ts.map(() => 30),
  ),
  seriesFrame(
    K2,
    ts,
    ts.map(() => 10),
  ),
);
const BARS: VisSpec = {
  kind: 'bars',
  title: 'T',
  unit: NONE,
  stacking: 'normal',
  categoryLabel: 'level',
  categoryOrder: ['a', 'b'],
};
const t6 = [0, 10_000, 20_000, 30_000, 40_000, 50_000];
const BARS_DATA = seriesData(
  seriesFrame(
    K1,
    t6,
    t6.map(() => 1),
    { level: 'a' },
  ),
  seriesFrame(
    K2,
    t6,
    t6.map(() => 2),
    { level: 'b' },
  ),
);
const sel = (keys: string[], fromMs: number | null = null, toMs: number | null = null) => ({
  keys,
  fromMs,
  toMs,
});

describe('unit:selection-draw', () => {
  it('line: k2 dimmed, then the focus underlay 4 px wider, then k1', () => {
    const h = frame(LINE, LINES);
    const ops = drawWith(h, sel([K1]));
    const strokes = ops.map((o, i) => ({ o, i })).filter((x) => x.o.op === 'stroke');
    const k2 = strokes.find((x) => x.o.strokeStyle === colourOf(K2));
    const under = strokes.find(
      (x) => x.o.strokeStyle === C.focus && x.o.lineWidth === size['chart-line'] + 4,
    );
    const k1 = strokes.find((x) => x.o.strokeStyle === colourOf(K1));
    expect(k2?.o.globalAlpha).toBe(0.35);
    expect(under?.o.globalAlpha).toBe(1);
    expect(k1?.o.globalAlpha).toBe(1);
    expect(k2?.i).toBeLessThan(under?.i ?? -1);
    expect(under?.i).toBeLessThan(k1?.i ?? -1);
  });

  it('line: a foreign key changes nothing; null draws as without a selection', () => {
    const base = plain(LINE, LINES);
    const h = frame(LINE, LINES);
    const foreign = drawWith(h, sel(['x']));
    expect(foreign.some((o) => o.globalAlpha !== 1)).toBe(false);
    expect(foreign.some((o) => o.op === 'stroke' && o.strokeStyle === C.focus)).toBe(false);
    drawWith(h, sel([K1]));
    expect(drawWith(h, null)).toEqual(base);
    expect(drawWith(h, sel([]))).toEqual(base);
  });

  it('line: an interval draws a band of at least one device px', () => {
    const h = frame(LINE, LINES, 2);
    const ops = drawWith(h, sel([], 30_000, 30_000));
    const s = last(h);
    const band = ops.find((o) => o.op === 'fillRect' && o.fillStyle === C.selection);
    expect(band?.args).toEqual([xOf(s, 30_000), s.plot.y, 0.5, s.plot.height]);
  });

  it('bars: k2 segments dimmed, k1 with a 2 px inner focus stroke', () => {
    const h = frame(BARS, BARS_DATA);
    const ops = drawWith(h, sel([K1]));
    const k2 = ops.filter((o) => o.op === 'fillRect' && o.fillStyle === colourOf(K2));
    const k1 = ops.filter((o) => o.op === 'fillRect' && o.fillStyle === colourOf(K1));
    expect(k2.length).toBeGreaterThan(0);
    expect(k2.every((o) => o.globalAlpha === 0.35)).toBe(true);
    expect(k1.every((o) => o.globalAlpha === 1)).toBe(true);
    const rings = ops.filter((o) => o.op === 'strokeRect' && o.strokeStyle === C.focus);
    expect(rings).toHaveLength(k1.length);
    expect(rings.every((o) => o.lineWidth === 2)).toBe(true);
    const [x, y, w, hh] = (k1[0]?.args ?? []) as number[];
    expect(rings[0]?.args).toEqual([(x ?? 0) + 1, (y ?? 0) + 1, (w ?? 0) - 2, (hh ?? 0) - 2]);
  });

  it('stat: a matched key draws a 2 px focus ring inside the tile', () => {
    const STAT: VisSpec = { kind: 'stat', title: 'S', unit: NONE };
    const h = frame(
      STAT,
      seriesData(
        seriesFrame(
          K1,
          ts,
          ts.map(() => 3),
        ),
      ),
    );
    const ops = drawWith(h, sel([K1]));
    const ring = ops.find((o) => o.op === 'strokeRect' && o.strokeStyle === C.focus);
    expect(ring?.lineWidth).toBe(2);
    expect(ring?.args).toEqual([1, 1, 398, 198]);
    const other = drawWith(h, sel([K2]));
    expect(other.some((o) => o.op === 'strokeRect')).toBe(false);
  });

  it('heatmap: a selection fill over [from, to)', () => {
    const SPEC: VisSpec = { kind: 'heatmap', title: 'H', unit: NONE, countUnit: NONE };
    const data: FrameData = {
      kind: 'heatmap',
      heatmap: {
        timestamps: new Float64Array([0, 1_000, 2_000, 3_000]),
        bounds: new Float64Array([1, 2]),
        counts: new Float64Array(8).fill(1),
      },
    };
    const h = frame(SPEC, data);
    const ops = drawWith(h, sel([], 1_000, 2_000));
    const s = last(h);
    const band = ops.find((o) => o.op === 'fillRect' && o.fillStyle === C.selection);
    expect(band?.args).toEqual([
      xOf(s, 1_000),
      s.plot.y,
      xOf(s, 2_000) - xOf(s, 1_000),
      s.plot.height,
    ]);
  });

  it('an equal selection redraws nothing', () => {
    const h = frame(LINE, LINES);
    expect(drawWith(h, sel([K1])).length).toBeGreaterThan(0);
    h.layer().clearOps();
    h.frame.setSelection(sel([K1]));
    expect(h.queued()).toBe(0);
    h.flush();
    expect(h.layer().ops).toHaveLength(0);
  });

  it('the selection tokens', () => {
    expect(C.selection).toBe('#5B9BFF29');
    expect(themeColours('light').selection).toBe('#2563C929');
    expect(C.dimmed).toBe(0.35);
  });
});
