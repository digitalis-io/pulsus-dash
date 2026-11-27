/**
 * The stat tile's layout (#282 Part 2a §4.4, ADR-0022 §4): the value top left, a reserved subline,
 * and a full-bleed sparkline under the head with a shaded area that spans the first to the last
 * finite point in the window and follows the line across absent points.
 */
import { describe, expect, it } from 'vitest';
import type { FrameData, VisSpec } from '../api';
import { colour } from '../../styles/tokens';
import { harness, seriesData, seriesFrame, type Harness } from '../../test/engineHarness';
import type { RecordedOp } from '../../test/recordingContext';
import { Canvas2DEngine } from './Canvas2DEngine';
import { seriesColourIndex, withAlpha } from './palette';

const KEY = '0000000000000003';
const SPEC: VisSpec = { kind: 'stat', title: 'T', unit: { kind: 'none' } };
const SEC = 1_000;
const MIN = 60 * SEC;

function show(
  data: FrameData,
  w: { fromMs: number; toMs: number },
  cssW: number,
  cssH: number,
): Harness {
  const h = harness(Canvas2DEngine);
  h.frame.setSpec(SPEC);
  h.frame.setData(data);
  h.frame.setTimeWindow(w);
  h.frame.resize(cssW, cssH, 1);
  h.flush();
  return h;
}

type Pt = readonly [number, number];

/** The vertices of the path that ends at `ops[end]` (back to its `beginPath`). */
function pathBefore(ops: readonly RecordedOp[], end: number): Pt[] {
  let start = end;
  while (start > 0 && ops[start]?.op !== 'beginPath') start -= 1;
  return ops
    .slice(start, end)
    .filter((o) => o.op === 'moveTo' || o.op === 'lineTo')
    .map((o) => [Number(o.args[0]), Number(o.args[1])] as const);
}

function areaOf(h: Harness): { fill: number; pts: Pt[] } {
  const ops = h.layer().ops;
  const fill = ops.findIndex((o) => o.op === 'fill' && o.fillStyle === 'gradient-or-pattern');
  expect(fill, 'an area fill with a gradient').toBeGreaterThanOrEqual(0);
  return { fill, pts: pathBefore(ops, fill) };
}

function lineOf(h: Harness): { stroke: number; pts: Pt[] } {
  const ops = h.layer().ops;
  const stroke = ops.findIndex((o) => o.op === 'stroke');
  expect(stroke, 'a sparkline stroke').toBeGreaterThanOrEqual(0);
  return { stroke, pts: pathBefore(ops, stroke) };
}

describe('unit:stat-layout', () => {
  const ts = Array.from({ length: 30 }, (_, i) => i * MIN);
  const vs = ts.map((_, i) => (i % 5) + 1);
  const s = seriesFrame(KEY, ts, vs);
  const w = { fromMs: 0, toMs: 29 * MIN };
  const hex = colour.dark[`series-${String(seriesColourIndex(s) + 1)}` as keyof typeof colour.dark];

  it('draws the value top left and a shaded full-bleed sparkline under the head', () => {
    const h = show(seriesData(s), w, 300, 160);
    const value = h.layer().calls('fillText')[0];
    expect(value?.args.slice(1)).toEqual([12, 28]);
    expect(value?.textAlign).toBe('left');
    expect(
      h
        .layer()
        .calls('createLinearGradient')
        .map((o) => o.args),
    ).toEqual([[0, 72, 0, 160]]);
    expect(
      h
        .layer()
        .calls('addColorStop')
        .map((o) => o.args),
    ).toEqual([
      [0, `${hex}47`],
      [1, `${hex}00`],
    ]);
    const area = areaOf(h);
    expect(area.pts.slice(-2)).toEqual([
      [300, 160],
      [0, 160],
    ]);
    const line = lineOf(h);
    expect(line.stroke).toBeGreaterThan(area.fill);
    expect(line.pts[0]?.[0]).toBe(0);
    expect(line.pts.at(-1)?.[0]).toBe(300);
  });

  it('draws no sparkline below 104 px, and one point as a dot without an area', () => {
    const short = show(seriesData(s), w, 300, 103);
    expect(short.layer().calls('stroke')).toHaveLength(0);
    expect(short.layer().calls('createLinearGradient')).toHaveLength(0);
    const one = seriesFrame(KEY, [0, 15 * MIN, 29 * MIN], [NaN, 3, NaN]);
    const dot = show(seriesData(one), w, 300, 160);
    expect(dot.layer().calls('arc')).toHaveLength(1);
    expect(dot.layer().calls('createLinearGradient')).toHaveLength(0);
  });

  it('withAlpha appends the alpha byte', () => {
    expect(withAlpha('#7AA2D6', 0.28)).toBe('#7AA2D647');
    expect(withAlpha('#7aa2d6', 0)).toBe('#7AA2D600');
    expect(withAlpha('#7AA2D6', 2)).toBe('#7AA2D6FF');
  });
});

describe('unit:stat-area-span', () => {
  const w = { fromMs: 0, toMs: 100 * SEC };

  it('(a) closes straight down at the first and last finite points', () => {
    const ts = [20, 30, 40, 50, 60, 70, 80].map((x) => x * SEC);
    const s = seriesFrame(KEY, ts, [1, 4, 2, 5, 3, 6, 2]);
    const area = areaOf(show(seriesData(s), w, 300, 160));
    expect(area.pts.slice(-2)).toEqual([
      [240, 160],
      [60, 160],
    ]);
    for (const [x] of area.pts) {
      expect(x).toBeGreaterThanOrEqual(60);
      expect(x).toBeLessThanOrEqual(240);
    }
  });

  it('(b) follows the line across a gap, never dropping to the bottom inside it', () => {
    const ts = [0, 10, 20, 30, 40, 60, 70, 80, 90, 100].map((x) => x * SEC);
    const s = seriesFrame(KEY, ts, [1, 4, 2, 5, 3, 6, 2, 4, 1, 3]);
    const h = show(seriesData(s), w, 300, 160);
    const area = areaOf(h);
    const line = lineOf(h);
    expect(area.pts.slice(0, -2)).toEqual(line.pts);
    for (const [x, y] of area.pts) {
      if (x > 120 && x < 180) expect(y).not.toBe(160);
    }
  });
});
