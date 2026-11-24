/**
 * Event markers on line, bars and heatmap (plan #64 Part C §4.2, ADR-0023): the label band, the
 * lines through the time transform above the series, the label layout (truncated, right-aligned at
 * the edge, gathered into `+N` chips, never dropped) and the summary's `eventLabels`.
 */
import { describe, expect, it } from 'vitest';
import type { EventMarker, FrameData, FrameSummary, VisSpec } from '../api';
import { harness, seriesData, seriesFrame, type Harness } from '../../test/engineHarness';
import { mulberry32 } from '../../test/random';
import type { RecordingContext } from '../../test/recordingContext';
import { colour, size, space } from '../../styles/tokens';
import { Canvas2DEngine } from './Canvas2DEngine';
import { EVENT_BAND } from './layout';

const W = { fromMs: 0, toMs: 60_000 };
const K1 = '0000000000000001';
const EVENT = colour.dark['text-muted'];
const CHIP = colour.dark['surface-2'];
const LINE: VisSpec = { kind: 'line', title: 'T', unit: { kind: 'none' } };
const DATA: FrameData = seriesData(seriesFrame(K1, [0, 20_000, 40_000, 60_000], [0, 10, 20, 30]));

function ev(
  id: string,
  atMs: number,
  title: string,
  kind: EventMarker['kind'] = 'deploy',
  endMs: number | null = null,
): EventMarker {
  return { id, atMs, endMs, kind, title };
}

interface Show {
  spec?: VisSpec;
  data?: FrameData;
  events?: readonly EventMarker[];
  size?: readonly [number, number];
  /** CSS px per code point of the layer's `measureText` (default: the recording context's 7 px per UTF-16 unit). */
  perCodePoint?: number;
}

function show(o: Show = {}): Harness {
  const h = harness(Canvas2DEngine);
  if (o.perCodePoint !== undefined) {
    const w = o.perCodePoint;
    (h.layer() as { measureText: (s: string) => TextMetrics }).measureText = (s: string) =>
      ({ width: w * Array.from(s).length }) as TextMetrics;
  }
  h.frame.setSpec(o.spec ?? LINE);
  h.frame.setData(o.data ?? DATA);
  h.frame.setTimeWindow(W);
  if (o.events !== undefined) h.frame.setEvents(o.events);
  h.frame.resize(o.size?.[0] ?? 400, o.size?.[1] ?? 200, 1);
  h.flush();
  return h;
}

function last(h: Harness): FrameSummary {
  const s = h.a11y.at(-1);
  expect(s, 'no a11y summary').not.toBeUndefined();
  if (s === undefined) throw new Error('no a11y summary');
  return s;
}

const xOf = (s: FrameSummary, t: number): number =>
  s.plot.x + ((t - s.fromMs) / (s.toMs - s.fromMs)) * s.plot.width;
const tAt = (s: FrameSummary, x: number): number =>
  s.fromMs + ((x - s.plot.x) / s.plot.width) * (s.toMs - s.fromMs);
const lineX = (s: FrameSummary, t: number): number => Math.round(xOf(s, t)) + 0.5;

interface Line {
  readonly x: number;
  readonly y0: number;
  readonly y1: number;
  /** The index of its `stroke` op. */
  readonly at: number;
}

/** Every stroked vertical two-point path in the event colour. */
function eventLines(ctx: RecordingContext): Line[] {
  const out: Line[] = [];
  let pts: [number, number][] = [];
  ctx.ops.forEach((o, k) => {
    if (o.op === 'beginPath') pts = [];
    else if (o.op === 'moveTo' || o.op === 'lineTo')
      pts.push([Number(o.args[0]), Number(o.args[1])]);
    else if (o.op === 'stroke' && o.strokeStyle === EVENT && pts.length === 2) {
      const [a, b] = pts;
      if (a !== undefined && b !== undefined && a[0] === b[0]) {
        out.push({ x: a[0], y0: Math.min(a[1], b[1]), y1: Math.max(a[1], b[1]), at: k });
      }
    }
  });
  return out;
}

/** The event label texts painted in the band (left-aligned at the band's top). */
function bandTexts(ctx: RecordingContext): string[] {
  return ctx.ops
    .filter(
      (o) => o.op === 'fillText' && o.textAlign === 'left' && Number(o.args[2]) === space['2'],
    )
    .map((o) => String(o.args[0]));
}

const L = (s: FrameSummary): number => s.plot.x;
const R = (s: FrameSummary): number => s.plot.x + s.plot.width;

describe('event markers', () => {
  it('event band and lines', () => {
    const h = show({ events: [ev('a', 30_000, 'v2.31')] });
    const s = last(h);
    expect(s.plot.y).toBe(space['2'] + EVENT_BAND);
    const x = lineX(s, 30_000);
    const lines = eventLines(h.layer());
    expect(lines.map((l) => [l.x, l.y0, l.y1])).toEqual([[x, s.plot.y, s.plot.y + s.plot.height]]);
    expect(
      s.eventLabels.map((b) => ({ ids: b.ids, text: b.text, clipped: b.clipped, x: b.x })),
    ).toEqual([{ ids: ['a'], text: '◆ v2.31', clipped: false, x }]);
    const b = s.eventLabels[0]?.box;
    expect(b === undefined ? NaN : b.y + b.height).toBeLessThanOrEqual(s.plot.y);
    expect(bandTexts(h.layer())).toEqual(['◆ v2.31']);
  });

  it('band rules', () => {
    const never = show();
    const empty = show({ events: [] });
    expect(empty.layer().ops).toEqual(never.layer().ops);
    expect(last(empty)).toEqual(last(never));
    expect(last(never).plot.y).toBe(space['2']);
    const out = show({ events: [ev('a', -1, 'x'), ev('b', 60_001, 'y'), ev('c', NaN, 'z')] });
    const s = last(out);
    expect(eventLines(out.layer())).toEqual([]);
    expect(s.eventLabels).toEqual([]);
    expect(s.plot.y).toBe(space['2'] + EVENT_BAND);
    expect(s.plot.height).toBe(last(never).plot.height - EVENT_BAND);
  });

  it('close markers gather', () => {
    const w = last(show()).plot.width;
    const h = show({ events: [ev('a', 30_000, 'a'), ev('b', 30_000 + 60_000 / w, 'b', 'config')] });
    const s = last(h);
    expect(eventLines(h.layer())).toHaveLength(2);
    expect(s.eventLabels).toHaveLength(1);
    expect(s.eventLabels[0]).toMatchObject({ ids: ['a', 'b'], text: '◆ a; ⚙ b', clipped: true });
    expect(bandTexts(h.layer())).toEqual(['+2']);
  });

  it('long label truncates before the next', () => {
    const w = last(show()).plot.width;
    const t1 = 10_000;
    const t2 = t1 + (100 * 60_000) / w;
    const title = 'x'.repeat(40);
    const h = show({ events: [ev('a', t1, title), ev('b', t2, title)] });
    const s = last(h);
    const [first, second] = s.eventLabels;
    expect(first?.clipped).toBe(true);
    expect(bandTexts(h.layer())[0]?.endsWith('…')).toBe(true);
    expect((first?.box.x ?? NaN) + (first?.box.width ?? NaN)).toBeLessThanOrEqual(
      (second?.box.x ?? NaN) - space['1'],
    );
  });

  it('right edge', () => {
    const one = show({ events: [ev('a', 60_000, 'v2.31')], perCodePoint: 6 });
    const s1 = last(one);
    const [b1] = s1.eventLabels;
    expect(b1).toMatchObject({ ids: ['a'], text: '◆ v2.31', clipped: false });
    expect(Math.abs((b1?.box.x ?? NaN) + (b1?.box.width ?? NaN) - R(s1))).toBeLessThanOrEqual(0.5);
    expect(b1?.box.x ?? NaN).toBeGreaterThanOrEqual(L(s1));
    expect(bandTexts(one.layer())).toEqual(['◆ v2.31']);
    const two = show({ events: [ev('a', 59_999, 'a'), ev('b', 60_000, 'b')], perCodePoint: 6 });
    const s2 = last(two);
    expect(s2.eventLabels).toHaveLength(1);
    const [b2] = s2.eventLabels;
    expect(b2).toMatchObject({ ids: ['a', 'b'], clipped: true });
    expect(Math.abs((b2?.box.x ?? NaN) + (b2?.box.width ?? NaN) - R(s2))).toBeLessThanOrEqual(0.5);
    expect(b2?.box.x ?? NaN).toBeGreaterThanOrEqual(L(s2));
    expect(bandTexts(two.layer())).toEqual(['+2']);
  });

  it('crowded edge merges', () => {
    const s0 = last(show({ events: [ev('c', 60_000, 'c', 'annotation')], perCodePoint: 6 }));
    const xc = lineX(s0, 60_000);
    const xb = xc - size['target-min'];
    const tb = tAt(s0, xb - 0.5);
    const h = show({
      events: [ev('b', tb, 'b'.repeat(40)), ev('c', 60_000, 'c', 'annotation')],
      perCodePoint: 6,
    });
    const s = last(h);
    expect(eventLines(h.layer()).map((l) => l.x)).toEqual([xb, xc]);
    const box = s.eventLabels.at(-1);
    expect(box).toMatchObject({ ids: ['b', 'c'], clipped: true });
    expect(box?.box.x).toBe(xb - space['1']);
    expect(bandTexts(h.layer()).at(-1)).toBe('+2');
    for (const b of s.eventLabels) {
      expect(b.box.x).toBeGreaterThanOrEqual(L(s));
      expect(b.box.x + b.box.width).toBeLessThanOrEqual(R(s));
    }
  });

  it('narrow plot', () => {
    const s0 = last(show());
    const cssW = s0.plot.x + 10 + space['2'];
    const events = [ev('a', 0, 'a'), ev('b', 30_000, 'b'), ev('c', 60_000, 'c')];
    const h = show({ events, size: [cssW, 200] });
    const s = last(h);
    expect(s.plot.width).toBe(10);
    expect(eventLines(h.layer())).toHaveLength(3);
    expect(s.eventLabels).toHaveLength(1);
    expect(s.eventLabels[0]?.box).toMatchObject({ x: L(s), width: 10 });
    expect(s.eventLabels[0]?.ids).toEqual(['a', 'b', 'c']);
    expect(bandTexts(h.layer())).toEqual([]);
  });

  it('label bounds hold', () => {
    const rnd = mulberry32(64_003);
    const kinds = ['deploy', 'config', 'flag', 'annotation'] as const;
    for (let n = 0; n < 200; n++) {
      const count = 1 + Math.floor(rnd() * 30);
      const cssW = 40 + Math.floor(rnd() * 761);
      const events = Array.from({ length: count }, (_, k) =>
        ev(
          `e${String(k)}`,
          Math.round(-5_000 + rnd() * 70_000),
          'w'.repeat(1 + Math.floor(rnd() * 40)),
          kinds[Math.floor(rnd() * 4)] ?? 'deploy',
        ),
      );
      const s = last(show({ events, size: [cssW, 200] }));
      const where = `set ${String(n)}, ${String(count)} events, width ${String(cssW)}`;
      if (!(s.plot.width > 0)) {
        expect(s.eventLabels, where).toEqual([]);
        continue;
      }
      const boxes = [...s.eventLabels].sort((a, b) => a.box.x - b.box.x);
      boxes.forEach((b, k) => {
        expect(b.box.x, where).toBeGreaterThanOrEqual(L(s));
        expect(b.box.x + b.box.width, where).toBeLessThanOrEqual(R(s) + 1e-9);
        const prev = boxes[k - 1];
        if (prev !== undefined) {
          expect(b.box.x - (prev.box.x + prev.box.width), where).toBeGreaterThanOrEqual(space['1']);
        }
      });
      const inView = events
        .filter((e) => e.atMs >= W.fromMs && e.atMs <= W.toMs)
        .map((e) => e.id)
        .sort();
      expect(boxes.flatMap((b) => b.ids).sort(), where).toEqual(inView);
    }
  });

  it('note has no glyph', () => {
    const s = last(show({ events: [ev('n', 30_000, 'Maintenance', 'annotation')] }));
    expect(s.eventLabels[0]?.text).toBe('Maintenance');
  });

  it('empty heatmap keeps its markers', () => {
    const spec: VisSpec = {
      kind: 'heatmap',
      title: 'H',
      unit: { kind: 'none' },
      countUnit: { kind: 'none' },
    };
    const empties: FrameData[] = [
      {
        kind: 'heatmap',
        heatmap: {
          timestamps: new Float64Array(0),
          bounds: new Float64Array(0),
          counts: new Float64Array(0),
        },
      },
      {
        kind: 'heatmap',
        heatmap: {
          timestamps: new Float64Array([0, 30_000]),
          bounds: new Float64Array(0),
          counts: new Float64Array(0),
        },
      },
    ];
    for (const data of empties) {
      const h = show({ spec, data, events: [ev('a', 30_000, 'v2.31')] });
      const s = last(h);
      expect(s.plot.y).toBe(space['2'] + EVENT_BAND);
      const x = lineX(s, 30_000);
      expect(eventLines(h.layer()).map((l) => [l.x, l.y0, l.y1])).toEqual([
        [x, s.plot.y, s.plot.y + s.plot.height],
      ]);
      expect(s.eventLabels.map((b) => ({ ids: b.ids, text: b.text, x: b.x }))).toEqual([
        { ids: ['a'], text: '◆ v2.31', x },
      ]);
      expect(bandTexts(h.layer())).toEqual(['◆ v2.31']);
    }
  });

  it('event line stays above filled series; stat has none', () => {
    const heatmap: { spec: VisSpec; data: FrameData } = {
      spec: {
        kind: 'heatmap',
        title: 'H',
        unit: { kind: 'none' },
        countUnit: { kind: 'none' },
      },
      data: {
        kind: 'heatmap',
        heatmap: {
          timestamps: new Float64Array([0, 15_000, 30_000, 45_000]),
          bounds: new Float64Array([1, 2, 4]),
          counts: new Float64Array(12).fill(9),
        },
      },
    };
    const bars: { spec: VisSpec; data: FrameData } = {
      spec: {
        kind: 'bars',
        title: 'B',
        unit: { kind: 'none' },
        stacking: 'normal',
        categoryLabel: 'level',
        categoryOrder: ['info'],
        thresholds: [{ value: 5, state: 'watch', label: 'w' }],
      },
      data: seriesData(
        seriesFrame(K1, [0, 15_000, 30_000, 45_000], [10, 10, 10, 10], { level: 'info' }),
      ),
    };
    for (const c of [heatmap, bars]) {
      const h = show({ spec: c.spec, data: c.data, events: [ev('a', 37_500, 'v2.31')] });
      const s = last(h);
      const ops = h.layer().ops;
      const [line] = eventLines(h.layer());
      expect(line, c.spec.kind).toBeDefined();
      if (line === undefined) continue;
      expect([line.y0, line.y1]).toEqual([s.plot.y, s.plot.y + s.plot.height]);
      const inPlot = (o: (typeof ops)[number]): boolean => {
        const [x, y, w, hh] = o.args.map(Number) as [number, number, number, number];
        return x <= line.x && x + w >= line.x && y < s.plot.y + s.plot.height && y + hh > s.plot.y;
      };
      const fills = ops
        .map((o, k) => ({ o, k }))
        .filter(({ o }) => o.op === 'fillRect' && inPlot(o));
      const series = fills.filter(
        ({ o }) => o.fillStyle !== CHIP && o.fillStyle !== colour.dark['surface-1'],
      );
      expect(series.length, `${c.spec.kind}: a filled mark under the line`).toBeGreaterThan(0);
      for (const { o, k } of fills) {
        if (k > line.at)
          expect(o.fillStyle, `${c.spec.kind}: a later fill over the line`).toBe(CHIP);
      }
      const strokes = ops
        .map((o, k) => ({ o, k }))
        .filter(({ o }) => o.op === 'stroke' && o.strokeStyle !== EVENT);
      for (const { k } of strokes)
        expect(k, `${c.spec.kind}: a stroke after the line`).toBeLessThan(line.at);
    }
    const stat = show({
      spec: { kind: 'stat', title: 'S', unit: { kind: 'none' } },
      data: { kind: 'scalar', scalar: { value: 3, timestampMs: 60_000 } },
      events: [ev('a', 30_000, 'v2.31')],
    });
    const s = last(stat);
    expect(eventLines(stat.layer())).toEqual([]);
    expect(s.eventLabels).toEqual([]);
    expect(s.plot).toEqual({ x: 0, y: 0, width: 400, height: 200 });
  });
});
