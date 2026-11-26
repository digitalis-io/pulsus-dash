// unit:selection-draw (T02-025, T25-006, ADR-0025, plan #192 §4.3, §5): the selection drawn in the
// layer pass.
import { describe, expect, it } from 'vitest';
import { size } from '../../styles/tokens';
import type { FrameData, FrameSelection, VisSpec } from '../api';
import { harness, pointer, seriesData, seriesFrame, type Harness } from '../../test/engineHarness';
import { last, xOf } from '../../test/cameraKit';
import type { RecordedOp } from '../../test/recordingContext';
import { Canvas2DEngine } from './Canvas2DEngine';
import { seriesColourIndex, themeColours } from './palette';

const K1 = '00000000000000a1';
const K2 = '00000000000000a2';
const K3 = '00000000000000a3';
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

/** The calls and the style each one uses (state left over from an earlier draw is not a call). */
const calls = (ops: readonly RecordedOp[]) =>
  ops.map((o) => ({
    op: o.op,
    args: o.args,
    alpha: o.globalAlpha,
    fill: o.op.startsWith('fill') ? o.fillStyle : null,
    stroke: o.op.startsWith('stroke') ? `${o.strokeStyle} ${String(o.lineWidth)}` : null,
  }));

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

const LINES3 = seriesData(
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
  seriesFrame(
    K3,
    ts,
    ts.map((_, i) => i / 3),
  ),
);
const ID = [1, 0, 0, 1, 0, 0];
const series = (o: RecordedOp, c: string): boolean =>
  ['stroke', 'fillRect', 'arc', 'fill'].includes(o.op) &&
  (o.op === 'stroke' ? o.strokeStyle === c : o.fillStyle === c);

describe('unit:selection-draw', () => {
  it('line: k2 dimmed, then the focus underlay 4 px wider, then k1', () => {
    const h = frame(LINE, LINES);
    h.scratch().clearOps();
    const ops = drawWith(h, sel([K1]));
    const strokes = ops.map((o, i) => ({ o, i })).filter((x) => x.o.op === 'stroke');
    // ADR-0032: k2 at alpha 1 on the scratch layer, composited once at `dimmed` before k1.
    const k2 = h.scratch().ops.find((o) => o.op === 'stroke' && o.strokeStyle === colourOf(K2));
    const composite = ops.findIndex((o) => o.op === 'drawImage' && o.globalAlpha === 0.35);
    const under = strokes.find(
      (x) => x.o.strokeStyle === C.focus && x.o.lineWidth === size['chart-line'] + 4,
    );
    const k1 = strokes.find((x) => x.o.strokeStyle === colourOf(K1));
    expect(k2?.globalAlpha).toBe(1);
    expect(under?.o.globalAlpha).toBe(1);
    expect(k1?.o.globalAlpha).toBe(1);
    expect(composite).toBeGreaterThanOrEqual(0);
    expect(composite).toBeLessThan(under?.i ?? -1);
    expect(under?.i).toBeLessThan(k1?.i ?? -1);
  });

  it('line: a foreign key changes nothing; null draws as without a selection', () => {
    const base = plain(LINE, LINES);
    const h = frame(LINE, LINES);
    const foreign = drawWith(h, sel(['x']));
    expect(foreign.some((o) => o.globalAlpha !== 1)).toBe(false);
    expect(foreign.some((o) => o.op === 'stroke' && o.strokeStyle === C.focus)).toBe(false);
    drawWith(h, sel([K1]));
    expect(calls(drawWith(h, null))).toEqual(calls(base));
    expect(calls(drawWith(h, sel([])))).toEqual(calls(base));
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

  it('canvas2d dim layer: the unmatched series on the scratch at alpha 1, one composite, then k1', () => {
    const h = frame(LINE, LINES3);
    h.scratch().clearOps();
    const ops = drawWith(h, sel([K1]));
    const sc = h.scratch().ops;
    // Step 1: identity and a device-px clear, before any save.
    expect(sc[0]).toMatchObject({ op: 'setTransform', args: ID });
    expect(sc[1]).toMatchObject({ op: 'clearRect', args: [0, 0, 400, 200] });
    // Step 2: one save/restore around the DPR transform and the strokes, at alpha 1.
    expect(sc[2]?.op).toBe('save');
    expect(sc.at(-1)?.op).toBe('restore');
    const strokes = sc.filter((o) => o.op === 'stroke');
    expect(strokes.map((o) => o.strokeStyle)).toEqual([colourOf(K2), colourOf(K3)]);
    expect(strokes.every((o) => o.globalAlpha === 1)).toBe(true);
    // Step 3: one composite at `dimmed`, under identity inside save/restore, before k1's underlay.
    const images = ops.map((o, i) => ({ o, i })).filter((x) => x.o.op === 'drawImage');
    expect(images).toHaveLength(1);
    const c = images[0];
    expect(c?.o.args).toEqual([h.scratchCanvas(), 0, 0]);
    expect(c?.o.globalAlpha).toBe(0.35);
    expect(c?.o.transform).toEqual(ID);
    expect(ops[(c?.i ?? 0) - 1]?.op).toBe('setTransform');
    expect(ops[(c?.i ?? 0) - 2]?.op).toBe('save');
    expect(ops[(c?.i ?? 0) + 1]?.op).toBe('restore');
    const under = ops.findIndex((o) => o.op === 'stroke' && o.strokeStyle === C.focus);
    expect(c?.i).toBeLessThan(under);
    // No per-stroke dimming left on the layer.
    expect(ops.some((o) => o.op === 'stroke' && o.globalAlpha !== 1)).toBe(false);
    expect(h.scratchCanvas().width).toBe(400);
    expect(h.scratchCanvas().height).toBe(200);
    // Released to 0×0 with no match.
    drawWith(h, null);
    expect([h.scratchCanvas().width, h.scratchCanvas().height]).toEqual([0, 0]);
  });

  it('canvas2d dim layer: released on a non-line spec, empty data, a zero size and dispose', () => {
    const released = (h: Harness, act: () => void): number[] => {
      drawWith(h, sel([K1]));
      expect(h.scratchCanvas().width).toBe(400);
      act();
      h.flush();
      return [h.scratchCanvas().width, h.scratchCanvas().height];
    };
    const h = frame(LINE, LINES3);
    expect(
      released(h, () => {
        h.frame.setSpec(BARS);
      }),
    ).toEqual([0, 0]);
    h.frame.setSpec(LINE);
    h.frame.setSelection(null);
    expect(
      released(h, () => {
        h.frame.setData(seriesData());
      }),
    ).toEqual([0, 0]);
    h.frame.setData(LINES3);
    h.frame.setSelection(null);
    expect(
      released(h, () => {
        h.frame.resize(0, 240, 1);
      }),
    ).toEqual([0, 0]);
    h.frame.resize(400, 200, 1);
    h.frame.setSelection(null);
    expect(
      released(h, () => {
        h.frame.dispose();
      }),
    ).toEqual([0, 0]);
  });

  it('canvas2d dim layer dpr2: the scratch under the DPR transform, the composite under identity', () => {
    const h = frame(LINE, LINES3, 2);
    h.scratch().clearOps();
    const ops = drawWith(h, sel([K1]));
    const sc = h.scratch().ops;
    expect(sc[1]).toMatchObject({ op: 'clearRect', args: [0, 0, 800, 400] });
    const strokes = sc.filter((o) => o.op === 'stroke');
    expect(strokes.length).toBe(2);
    expect(strokes.every((o) => o.transform.join() === '2,0,0,2,0,0')).toBe(true);
    const c = ops.find((o) => o.op === 'drawImage');
    expect(c?.transform).toEqual(ID);
    const k1 = ops.filter(
      (o) => o.op === 'stroke' && (o.strokeStyle === C.focus || o.strokeStyle === colourOf(K1)),
    );
    expect(k1).toHaveLength(2);
    expect(k1.every((o) => o.transform.join() === '2,0,0,2,0,0' && o.globalAlpha === 1)).toBe(true);
    // The hover overlay on the visible canvas: the DPR transform, alpha 1.
    const s = last(h);
    h.visible().clearOps();
    pointer(h.canvas, 'pointermove', s.plot.x + s.plot.width / 2, s.plot.y + 20);
    h.flush();
    const over = h.visible().ops.filter((o) => o.op === 'fillRect' || o.op === 'fill');
    expect(over.length).toBeGreaterThan(0);
    expect(over.every((o) => o.transform.join() === '2,0,0,2,0,0' && o.globalAlpha === 1)).toBe(
      true,
    );
  });

  it('canvas2d dim layer marks: every drawLineSeries op of an unmatched series moves to the scratch', () => {
    // K2: a dense column (several samples in one px), an isolated sample between gaps (a dot).
    const t = [0, 100, 200, 300, 400, 10_000, 30_000, 31_000, 40_000, 60_000];
    const v = [1, 9, 2, 8, 3, 5, NaN, 7, NaN, 6];
    const data = seriesData(
      seriesFrame(
        K1,
        ts,
        ts.map(() => 30),
      ),
      seriesFrame(K2, t, v),
    );
    const plainOps = plain(LINE, data).filter((o) => series(o, colourOf(K2)));
    expect(plainOps.some((o) => o.op === 'fillRect')).toBe(true);
    expect(plainOps.some((o) => o.op === 'arc')).toBe(true);
    const h = frame(LINE, data);
    h.scratch().clearOps();
    const ops = drawWith(h, sel([K1]));
    const moved = h.scratch().ops.filter((o) => series(o, colourOf(K2)));
    const strip = (x: readonly RecordedOp[]) => x.map((o) => ({ op: o.op, args: o.args }));
    expect(strip(moved)).toEqual(strip(plainOps));
    expect(moved.every((o) => o.globalAlpha === 1)).toBe(true);
    expect(ops.some((o) => series(o, colourOf(K2)))).toBe(false);
    expect(ops.filter((o) => o.op === 'drawImage' && o.globalAlpha === 0.35)).toHaveLength(1);
  });

  it('canvas2d dim layer clip: one balanced save/restore per draw; a clip only under a pin', () => {
    const h = frame(LINE, LINES3);
    const check = (manual: boolean): RecordedOp[] => {
      const sc = h.scratch().ops;
      const saves = sc.filter((o) => o.op === 'save').length;
      expect(saves).toBe(sc.filter((o) => o.op === 'restore').length);
      expect(saves).toBe(manual ? 2 : 1);
      const clear = sc.findIndex((o) => o.op === 'clearRect');
      expect(clear).toBeGreaterThanOrEqual(0);
      expect(clear).toBeLessThan(sc.findIndex((o) => o.op === 'save'));
      expect(sc[clear]?.transform).toEqual(ID);
      expect(sc.some((o) => o.op === 'clip')).toBe(manual);
      return [...sc];
    };
    h.scratch().clearOps();
    drawWith(h, sel([K1]));
    check(false);
    h.scratch().clearOps();
    h.frame.setSpec({ ...LINE, valueRange: { min: 0, max: 10 } });
    h.flush();
    check(true);
    h.scratch().clearOps();
    h.frame.setSpec(LINE);
    h.frame.resize(300, 150, 1);
    h.flush();
    const third = check(false);
    const f = harness(Canvas2DEngine);
    f.frame.setSpec(LINE);
    f.frame.setData(LINES3);
    f.frame.setTimeWindow(W);
    f.frame.resize(300, 150, 1);
    f.frame.setSelection(sel([K1]));
    f.flush();
    expect(calls(third)).toEqual(calls(f.scratch().ops));
  });
});
