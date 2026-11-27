/**
 * The line area, grid and joins in Canvas 2D (#282 Part 2b §4.2, §5; ADR-0036):
 * `unit:canvas-area`, `unit:canvas-area-crossing`, `unit:canvas-joins`, `unit:canvas-grid` and
 * `unit:canvas-area-order`, on a recording context.
 */
import { describe, expect, it } from 'vitest';
import type { FrameData, FrameSelection, FrameSummary, VisSpec } from '../api';
import { galleryEntries } from '../../dev/gallery';
import { harness, seriesData, seriesFrame, type Harness } from '../../test/engineHarness';
import type { RecordedOp } from '../../test/recordingContext';
import { colour, opacity, seriesPalette } from '../../styles/tokens';
import { Canvas2DEngine } from './Canvas2DEngine';
import { seriesColourIndex, withAlpha } from './palette';

const W = { fromMs: Date.UTC(2026, 10, 19, 12), toMs: Date.UTC(2026, 10, 19, 13) };

function show(spec: VisSpec, data: FrameData, sel: FrameSelection | null = null): Harness {
  const h = harness(Canvas2DEngine);
  h.frame.setSpec(spec);
  h.frame.setData(data);
  h.frame.setTimeWindow(W);
  if (sel !== null) h.frame.setSelection(sel);
  h.frame.resize(800, 240, 1);
  h.flush();
  return h;
}

function last(h: Harness): FrameSummary {
  const s = h.a11y.at(-1);
  if (s === undefined) throw new Error('no a11y summary');
  return s;
}

function entry(id: string): { spec: VisSpec; data: FrameData } {
  const e = galleryEntries(W).find((x) => x.id === id);
  if (e === undefined) throw new Error(`no gallery entry ${id}`);
  return e;
}

/** The area fills: each `fill` with a gradient, with the path ops since its `beginPath`. */
function areaFills(h: Harness): { path: RecordedOp[]; at: number }[] {
  const ops = h.layer().ops;
  const out: { path: RecordedOp[]; at: number }[] = [];
  let path: RecordedOp[] = [];
  ops.forEach((o, k) => {
    if (o.op === 'beginPath') path = [];
    else if (['moveTo', 'lineTo', 'closePath'].includes(o.op)) path.push(o);
    else if (o.op === 'fill' && o.fillStyle === 'gradient-or-pattern') out.push({ path, at: k });
  });
  return out;
}

const AREA: Extract<VisSpec, { kind: 'line' }> = {
  kind: 'line',
  title: 'T',
  unit: { kind: 'none' },
  area: true,
};

describe('Canvas 2D line area (unit:canvas-area)', () => {
  it('draws one gradient per series at chart-area ÷ shown, clipped, gaps as closed subpaths', () => {
    const e = entry('line-area');
    const h = show(e.spec, e.data);
    const s = last(h);
    const bottom = s.plot.y + s.plot.height;
    const grads = h.layer().calls('createLinearGradient');
    expect(grads.map((o) => o.args)).toEqual([
      [0, s.plot.y, 0, bottom],
      [0, s.plot.y, 0, bottom],
      [0, s.plot.y, 0, bottom],
    ]);
    const series = e.data.kind === 'series' ? e.data.series : [];
    const stops = h.layer().calls('addColorStop');
    series.forEach((sf, k) => {
      const c = seriesPalette.dark[seriesColourIndex(sf)] ?? '';
      expect(stops[2 * k]?.args).toEqual([0, withAlpha(c, opacity['chart-area'] / 3)]);
      expect(stops[2 * k + 1]?.args).toEqual([1, withAlpha(c, 0)]);
    });
    const fills = areaFills(h);
    expect(fills).toHaveLength(3);
    const clipAt = h.layer().ops.findIndex((o) => o.op === 'clip');
    expect(clipAt).toBeGreaterThanOrEqual(0);
    expect(clipAt).toBeLessThan(fills[0]?.at ?? -1);
    const gapPath = fills[2]?.path ?? [];
    expect(gapPath.filter((o) => o.op === 'closePath')).toHaveLength(2);
    const moves = gapPath.filter((o) => o.op === 'moveTo');
    expect(moves).toHaveLength(2);
    for (const m of moves) {
      expect(m.args[1]).toBe(bottom);
      expect(Number.isInteger(Number(m.args[0]) - s.plot.x - 0.5)).toBe(true);
    }
  });

  it('draws none for 5 series, with area off, or under any selection', () => {
    const five = seriesData(
      ...[1, 2, 3, 4, 5].map((k) =>
        seriesFrame(`000000000000000${String(k)}`, [W.fromMs, W.toMs], [k, k + 1]),
      ),
    );
    const three = seriesData(
      ...[1, 2, 3].map((k) =>
        seriesFrame(`000000000000000${String(k)}`, [W.fromMs, W.toMs], [k, k + 1]),
      ),
    );
    const none = (h: Harness): number => h.layer().calls('createLinearGradient').length;
    expect(none(show(AREA, five))).toBe(0);
    expect(none(show({ ...AREA, area: false }, three))).toBe(0);
    expect(none(show(AREA, three))).toBe(3);
    const sel = (keys: string[]): FrameSelection => ({ keys, fromMs: null, toMs: null });
    expect(none(show(AREA, three, sel(['0000000000000002'])))).toBe(0);
    expect(none(show(AREA, three, sel(['00000000000000ff'])))).toBe(0);
  });
});

describe('Canvas 2D area edges (unit:canvas-area-crossing)', () => {
  /** One join over the whole plot: (va → vb) on the pinned [0, 200]. */
  function join(va: number, vb: number, sameColumn = false) {
    const t1 = sameColumn ? W.fromMs + 1 : W.toMs;
    const spec: VisSpec = { ...AREA, valueRange: { min: 0, max: 200 } };
    const h = show(spec, seriesData(seriesFrame('0000000000000001', [W.fromMs, t1], [va, vb])));
    const s = last(h);
    const path = areaFills(h)[0]?.path ?? [];
    const pts = path
      .filter((o) => o.op !== 'closePath')
      .map((o) => [Number(o.args[0]), Number(o.args[1])] as const);
    return { s, pts, fills: areaFills(h).length };
  }

  it('(a) fills from the top up to the crossing, then from the line', () => {
    const { s, pts } = join(250, 100);
    const x0 = s.plot.x + 0.5;
    const x1 = s.plot.x + Math.floor(s.plot.width) - 0.5;
    const cross = x0 + (x1 - x0) / 3;
    expect(pts.some(([x, y]) => x === x0 && y === s.plot.y)).toBe(true);
    expect(pts.some(([x, y]) => Math.abs(x - cross) < 1e-6 && y === s.plot.y)).toBe(true);
  });

  it('(c) runs along the top, (d) along the bottom, (f) draws nothing', () => {
    const c = join(280, 240);
    const tops = c.pts.filter(([, y]) => y !== c.s.plot.y + c.s.plot.height);
    expect(tops.every(([, y]) => y === c.s.plot.y)).toBe(true);
    const d = join(-20, -100);
    expect(d.pts.every(([, y]) => y === d.s.plot.y + d.s.plot.height)).toBe(true);
    expect(join(180, 100, true).fills).toBe(0);
  });
});

describe('Canvas 2D joins and grid', () => {
  it('(unit:canvas-joins) joins 100 → 200.first and 200.last → 300, nothing inside 200', () => {
    const at = (c: number): number => W.fromMs + ((c + 0.5) / 400) * (W.toMs - W.fromMs);
    const ts = [at(100), at(200) - 1, at(200), at(200) + 1, at(300)];
    const spec: VisSpec = { ...AREA, valueRange: { min: 0, max: 100 } };
    const h = show(spec, seriesData(seriesFrame('0000000000000001', ts, [30, 60, NaN, 40, 50])));
    const strokes: RecordedOp[][] = [];
    let path: RecordedOp[] = [];
    for (const o of h.layer().ops) {
      if (o.op === 'beginPath') path = [];
      else if (o.op === 'moveTo' || o.op === 'lineTo') path.push(o);
      else if (o.op === 'stroke') strokes.push(path);
    }
    const line = strokes.find((p) => p.length >= 4) ?? [];
    const ops = line.map((o) => o.op);
    // 100: move, (zero-length) line; 200: line to first, move to last; 300: line, line.
    expect(ops).toEqual(['moveTo', 'lineTo', 'lineTo', 'moveTo', 'lineTo', 'lineTo']);
    const ys = line.map((o) => Number(o.args[1]));
    expect(ys[2]).toBeLessThan(ys[3] ?? 0);
    const area = areaFills(h)[0]?.path ?? [];
    const tops = area.map((o) => [Number(o.args[0]), Number(o.args[1])]);
    expect(tops).toContainEqual([Number(line[2]?.args[0]), ys[2]]);
    expect(tops).toContainEqual([Number(line[3]?.args[0]), ys[3]]);
  });

  it('(unit:canvas-grid) guides in chart-grid, the baseline in chart-axis', () => {
    const h = show(
      { kind: 'line', title: 'T', unit: { kind: 'none' } },
      seriesData(seriesFrame('0000000000000001', [W.fromMs, W.toMs], [0, 30])),
    );
    const s = last(h);
    const rects = h.layer().calls('fillRect');
    const guides = rects.filter((o) => o.args[2] === s.plot.width && o.args[3] === 1);
    const bottom = Math.round(s.plot.y + s.plot.height) - 1;
    const base = guides.filter((o) => o.args[0] === s.plot.x && o.args[1] === bottom);
    expect(base.map((o) => o.fillStyle)).toEqual([colour.dark['chart-axis']]);
    const grid = guides.filter((o) => o.args[1] !== bottom);
    expect(grid.length).toBeGreaterThan(1);
    expect(new Set(grid.map((o) => o.fillStyle))).toEqual(new Set([colour.dark['chart-grid']]));
  });

  it('(unit:canvas-area-order) every area fill precedes the first stroke', () => {
    const two = seriesData(
      seriesFrame('0000000000000001', [W.fromMs, W.toMs], [50, 50]),
      seriesFrame('0000000000000002', [W.fromMs, W.toMs], [90, 90]),
    );
    const h = show({ ...AREA, valueRange: { min: 0, max: 100 } }, two);
    const fills = areaFills(h);
    expect(fills).toHaveLength(2);
    const firstStroke = h.layer().ops.findIndex((o) => o.op === 'stroke');
    expect(fills.every((f) => f.at < firstStroke)).toBe(true);
  });
});
