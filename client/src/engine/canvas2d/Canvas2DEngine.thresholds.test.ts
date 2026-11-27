/**
 * Threshold lines and labels on line and bars (plan #64 Part B §4.2, Appendix B.4; ADR-0022): the
 * dashed state-coloured mark, the auto domain, the label layout (stacked, truncated, shifted or in
 * an overflow chip, never dropped) and the pinned axis.
 */
import { describe, expect, it } from 'vitest';
import type { FrameData, FrameSummary, ThresholdLine, VisSpec } from '../api';
import { harness, seriesData, seriesFrame, type Harness } from '../../test/engineHarness';
import type { RecordingContext } from '../../test/recordingContext';
import { CHAR_WIDTH } from '../../test/recordingContext';
import { colour, seriesPalette, size, space } from '../../styles/tokens';
import { Canvas2DEngine } from './Canvas2DEngine';
import { LABEL_HEIGHT } from './layout';

const H = LABEL_HEIGHT;
const G = space['1'];
const W = { fromMs: 0, toMs: 3_000 };
const K1 = '0000000000000001';
const K2 = '0000000000000002';
const GLYPHS = ['●', '◐', '◉', '■', '○'];

/** One series 0, 10, 20, 30 over the window: the data spans 0..30. */
const DATA: FrameData = seriesData(seriesFrame(K1, [0, 1_000, 2_000, 3_000], [0, 10, 20, 30]));

function line(thresholds: readonly ThresholdLine[], extra: Partial<VisSpec> = {}): VisSpec {
  return { kind: 'line', title: 'T', unit: { kind: 'none' }, thresholds, ...extra } as VisSpec;
}

function show(spec: VisSpec, data: FrameData = DATA, size: readonly [number, number] = [800, 240]) {
  const h = harness(Canvas2DEngine);
  h.frame.setSpec(spec);
  h.frame.setData(data);
  h.frame.setTimeWindow(W);
  h.frame.resize(size[0], size[1], 1);
  h.flush();
  return h;
}

function last(h: Harness): FrameSummary {
  const s = h.a11y.at(-1);
  expect(s, 'no a11y summary').not.toBeUndefined();
  if (s === undefined) throw new Error('no a11y summary');
  return s;
}

/** The y of a threshold line: `Math.round(y) + 0.5` of the value (§4.2), within 1 px of it. */
function lineAt(s: FrameSummary, v: number): number {
  return Math.round(yOf(s, v)) + 0.5;
}

/** The value axis mapping of the summary. */
function yOf(s: FrameSummary, v: number): number {
  const a = s.valueAxis;
  expect(a, 'no value axis').not.toBeNull();
  if (a === null) throw new Error('no value axis');
  return s.plot.y + (1 - (v - a.min) / (a.max - a.min)) * s.plot.height;
}

interface Path {
  readonly points: readonly (readonly [number, number])[];
  readonly strokeStyle: string;
  readonly dash: readonly number[];
}

/** Every stroked path with the line dash in effect (save and restore included). */
function strokedPaths(ctx: RecordingContext): Path[] {
  const out: Path[] = [];
  let points: [number, number][] = [];
  let dash: readonly number[] = [];
  const stack: (readonly number[])[] = [];
  for (const o of ctx.ops) {
    switch (o.op) {
      case 'save':
        stack.push(dash);
        break;
      case 'restore':
        dash = stack.pop() ?? [];
        break;
      case 'setLineDash':
        dash = o.args[0] as number[];
        break;
      case 'beginPath':
        points = [];
        break;
      case 'moveTo':
      case 'lineTo':
        points.push([Number(o.args[0]), Number(o.args[1])]);
        break;
      case 'stroke':
        out.push({ points, strokeStyle: o.strokeStyle, dash });
        break;
    }
  }
  return out;
}

const dashed = (h: Harness): Path[] => strokedPaths(h.layer()).filter((p) => p.dash.length > 0);

/** Solid vertical strokes (the leaders). */
const leaders = (h: Harness): Path[] =>
  strokedPaths(h.layer()).filter(
    (p) =>
      p.dash.length === 0 &&
      p.points.length === 2 &&
      p.points[0]?.[0] === p.points[1]?.[0] &&
      p.points[0]?.[1] !== p.points[1]?.[1],
  );

const glyphTexts = (h: Harness): string[] =>
  h
    .layer()
    .calls('fillText')
    .map((o) => String(o.args[0]))
    .filter((t) => GLYPHS.some((g) => t.startsWith(g)) || t.startsWith('+'));

function maxW(s: FrameSummary): number {
  return Math.max(0, Math.min(s.plot.width - 2 * space['2'], Math.round(s.plot.width / 2)));
}

function disjoint(s: FrameSummary): boolean {
  const boxes = [...s.thresholdLabels].sort((a, b) => a.box.y - b.box.y);
  return boxes.every((b, k) => {
    const next = boxes[k + 1];
    return next === undefined || b.box.y + b.box.height + G <= next.box.y + 1e-9;
  });
}

describe('unit:threshold-mark (#64 Part B §4.2)', () => {
  it('threshold lines: dashed, state colour, glyph label', () => {
    const h = show(line([{ value: 20, state: 'degraded', label: 'SLO' }]));
    const s = last(h);
    const dashes = h.layer().calls('setLineDash');
    expect(dashes.map((o) => o.args[0])).toEqual([[size['chart-dash'], size['chart-dash-gap']]]);
    const d = dashed(h);
    expect(d).toHaveLength(1);
    const path = d[0];
    expect(path, 'no dashed path').not.toBeUndefined();
    if (path === undefined) throw new Error('no dashed path');
    expect(path.strokeStyle).toBe(colour.dark.degraded);
    expect(path.points).toHaveLength(2);
    expect(path.points[0]?.[0]).toBe(s.plot.x);
    expect(path.points[1]?.[0]).toBe(s.plot.x + s.plot.width);
    expect(path.points[0]?.[1]).toBe(lineAt(s, 20));
    expect(
      h
        .layer()
        .calls('fillText')
        .some((o) => o.args[0] === '◉ SLO' && o.fillStyle === colour.dark.degraded),
    ).toBe(true);
    expect(s.thresholdLabels).toHaveLength(1);
    expect(s.thresholdLabels[0]).toMatchObject({ text: '◉ SLO', clipped: false });
  });

  it('auto domain includes thresholds', () => {
    const h = show(line([{ value: 50, state: 'watch', label: '' }]));
    const s = last(h);
    expect(s.valueAxis?.max).toBeGreaterThanOrEqual(50);
    expect(s.max).toBe(30);
  });

  it('colliding labels stack; none is dropped', () => {
    const h = show(
      line([
        { value: 20, state: 'degraded', label: 'SLO' },
        { value: 20.01, state: 'watch', label: 'Warn' },
      ]),
    );
    const s = last(h);
    expect(s.thresholdLabels).toHaveLength(2);
    const [first, second] = s.thresholdLabels;
    expect(first, 'two labels expected').not.toBeUndefined();
    expect(second, 'two labels expected').not.toBeUndefined();
    if (first === undefined || second === undefined) throw new Error('two labels expected');
    expect(s.thresholdLabels).toHaveLength(2);
    // 20.01 sits higher, so its desired top comes first in stack order.
    expect(first.text).toBe('◐ Warn');
    expect(second.text).toBe('◉ SLO');
    expect(second.box.y).toBeCloseTo(first.box.y + H + G, 9);
    expect(first.clipped || second.clipped).toBe(false);
    expect(disjoint(s)).toBe(true);
    expect(glyphTexts(h).sort()).toEqual(['◉ SLO', '◐ Warn'].sort());
    const moved = leaders(h).filter((p) => p.strokeStyle === colour.dark.degraded);
    expect(moved).toHaveLength(1);
    expect(moved[0]?.points[0]?.[0]).toBe(s.plot.x + space['1']);
  });

  it('a long label is truncated and reported', () => {
    const label = 'p99 latency objective for checkout payments in eu-west-1 during peak hours';
    const h = show(line([{ value: 20, state: 'failing', label }]));
    const s = last(h);
    expect(glyphTexts(h)).toHaveLength(1);
    const [drawn] = glyphTexts(h);
    expect(drawn, 'no label drawn').not.toBeUndefined();
    if (drawn === undefined) throw new Error('no label drawn');
    expect(drawn.endsWith('…')).toBe(true);
    expect(drawn.startsWith('■ p99')).toBe(true);
    expect(CHAR_WIDTH * drawn.length).toBeLessThanOrEqual(maxW(s) - 2 * space['1']);
    expect(s.thresholdLabels).toHaveLength(1);
    expect(s.thresholdLabels[0]).toMatchObject({ text: `■ ${label}`, clipped: true });
  });

  it('labels clustered at the bottom edge shift up whole', () => {
    const h = show(
      line(
        ['a', 'b', 'c', 'd'].map((label, i) => ({
          value: (i + 1) / 10,
          state: 'watch' as const,
          label,
        })),
      ),
    );
    const s = last(h);
    const bottom = s.plot.y + s.plot.height;
    expect(bottom - yOf(s, 0.4)).toBeLessThan(10);
    const boxes = s.thresholdLabels;
    expect(boxes.map((b) => b.text)).toEqual(['◐ d', '◐ c', '◐ b', '◐ a']);
    for (const b of boxes) {
      expect(b.box.height).toBe(H);
      expect(b.box.y).toBeGreaterThanOrEqual(s.plot.y);
      expect(b.box.y + b.box.height).toBeLessThanOrEqual(bottom + 1e-9);
      expect(b.clipped).toBe(false);
    }
    const lastBox = boxes.at(-1);
    expect((lastBox?.box.y ?? NaN) + H).toBeCloseTo(bottom, 9);
    boxes.forEach((b, k) => {
      const next = boxes[k + 1];
      if (next !== undefined) expect(next.box.y - b.box.y).toBeCloseTo(H + G, 9);
    });
  });

  it('clustered labels that cannot fit overflow into the chip', () => {
    const lines = Array.from({ length: 8 }, (_, i) => ({
      value: (i + 1) / 10,
      state: 'watch' as const,
      label: `t${String(i + 1)}`,
    }));
    const h = show(line(lines), DATA, [800, 80]);
    const s = last(h);
    const n = Math.floor((s.plot.height + G) / (H + G));
    expect(n).toBeGreaterThanOrEqual(1);
    const boxes = s.thresholdLabels;
    expect(boxes).toHaveLength(n);
    const chips = boxes.filter((b) => /^\+\d+$/.test(glyphTextOf(h, b.box.y)));
    expect(chips).toHaveLength(1);
    const chip = chips[0];
    expect(chip?.clipped).toBe(true);
    expect(glyphTexts(h)).toContain(`+${String(9 - n)}`);
    const shown = new Set(boxes.filter((b) => b !== chip).map((b) => b.text));
    const hidden = lines.map((l) => `◐ ${l.label}`).filter((t) => !shown.has(t));
    expect(hidden).toHaveLength(9 - n);
    expect(chip?.text.split('; ').sort()).toEqual([...hidden].sort());
    const bottom = s.plot.y + s.plot.height;
    for (const b of boxes) {
      expect(b.box.height).toBe(H);
      expect(b.box.y).toBeGreaterThanOrEqual(s.plot.y - 1e-9);
      expect(b.box.y + H).toBeLessThanOrEqual(bottom + 1e-9);
    }
    expect(disjoint(s)).toBe(true);
  });

  it('a threshold outside the pin: no line, label at the edge', () => {
    const h = show(
      line([{ value: 50, state: 'degraded', label: 'Cap' }], { valueRange: { min: 0, max: 30 } }),
    );
    const s = last(h);
    expect(s.valueAxis).toMatchObject({ min: 0, max: 30, manual: true });
    expect(dashed(h)).toHaveLength(0);
    expect(s.thresholdLabels).toHaveLength(1);
    expect(s.thresholdLabels[0]?.box.y).toBe(s.plot.y);
    expect(s.thresholdLabels[0]?.text).toBe('◉ Cap');
    expect(glyphTexts(h)).toEqual(['◉ Cap']);
    const toEdge = leaders(h).filter((p) => p.strokeStyle === colour.dark.degraded);
    expect(toEdge).toHaveLength(1);
    expect(toEdge[0]?.points.map((p) => p[1])).toContain(s.plot.y);
  });

  it('bars domain: stacked totals, with and without thresholds', () => {
    const bars = (thresholds?: readonly ThresholdLine[]): VisSpec => ({
      kind: 'bars',
      title: 'T',
      unit: { kind: 'none' },
      stacking: 'normal',
      categoryLabel: 'level',
      categoryOrder: [],
      ...(thresholds === undefined ? {} : { thresholds }),
    });
    const data = seriesData(
      seriesFrame(K1, [0, 1_000], [2, 3], { level: 'a' }),
      seriesFrame(K2, [0, 1_000], [4, 1], { level: 'b' }),
    );
    const none = show(bars(), data);
    const sNone = last(none);
    expect(sNone.valueAxis?.max).toBeGreaterThanOrEqual(6);
    expect(sNone.max).toBe(6);
    const palette = new Set<string>(seriesPalette.dark);
    const tops = none
      .layer()
      .calls('fillRect')
      .filter((o) => palette.has(o.fillStyle) && o.args[0] === Math.min(...barXs(none)))
      .map((o) => Number(o.args[1]));
    expect(Math.min(...tops)).toBeGreaterThanOrEqual(sNone.plot.y);
    expect(dashed(none)).toHaveLength(0);

    const five = show(bars([{ value: 5, state: 'watch', label: '' }]), data);
    const sFive = last(five);
    expect(sFive.valueAxis).toEqual(sNone.valueAxis);
    expect(sFive.max).toBe(6);
    expect(dashed(five)).toHaveLength(1);
    expect(dashed(five)[0]?.points[0]?.[1]).toBe(lineAt(sFive, 5));

    const nine = show(bars([{ value: 9, state: 'failing', label: '' }]), data);
    const sNine = last(nine);
    expect(sNine.valueAxis?.max).toBeGreaterThanOrEqual(9);
    expect(sNine.max).toBe(6);
    expect(dashed(nine)).toHaveLength(1);
    expect(dashed(nine)[0]?.points[0]?.[1]).toBe(lineAt(sNine, 9));
  });
});

/** The x of every series-coloured bar rect. */
function barXs(h: Harness): number[] {
  const palette = new Set<string>(seriesPalette.dark);
  return h
    .layer()
    .calls('fillRect')
    .filter((o) => palette.has(o.fillStyle))
    .map((o) => Number(o.args[0]));
}

/** The text drawn in the label box whose top is `top`. */
function glyphTextOf(h: Harness, top: number): string {
  const mid = top + H / 2;
  const t = h
    .layer()
    .calls('fillText')
    .find(
      (o) =>
        Math.abs(Number(o.args[2]) - mid) < 1e-6 &&
        (GLYPHS.some((g) => String(o.args[0]).startsWith(g)) || String(o.args[0]).startsWith('+')),
    );
  return t === undefined ? '' : String(t.args[0]);
}
