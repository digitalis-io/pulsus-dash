// unit:engine-select (T25-005, ADR-0025, plan #192 §4.3, §5): a click is a left press with no
// modifier that travelled < chart-brush-min px and committed no camera move; it emits `select` with
// the mark under it.
import { describe, expect, it } from 'vitest';
import type { FrameData, SelectEvent, VisSpec } from '../api';
import { harness, seriesData, seriesFrame, type Harness } from '../../test/engineHarness';
import { last, xOf, yOf } from '../../test/cameraKit';
import { Canvas2DEngine } from './Canvas2DEngine';

const K1 = '00000000000000a1';
const K2 = '00000000000000a2';
const W = { fromMs: 0, toMs: 60_000 };
const NONE = { kind: 'none' } as const;
const LINE: VisSpec = { kind: 'line', title: 'T', unit: NONE };

function frame(spec: VisSpec, data: FrameData): { h: Harness; sel: SelectEvent[] } {
  const h = harness(Canvas2DEngine);
  const sel: SelectEvent[] = [];
  h.frame.on('select', (e) => sel.push(e));
  h.frame.setSpec(spec);
  h.frame.setData(data);
  h.frame.setTimeWindow(W);
  h.frame.resize(400, 200, 1);
  h.flush();
  return { h, sel };
}

function down(h: Harness, x: number, y: number, o: Partial<PointerEventInit> = {}): void {
  h.canvas.dispatchEvent(
    new PointerEvent('pointerdown', {
      clientX: x,
      clientY: y,
      button: 0,
      pointerId: 1,
      pointerType: 'mouse',
      bubbles: true,
      cancelable: true,
      ...o,
    }),
  );
}
function move(h: Harness, x: number, y: number): void {
  h.canvas.dispatchEvent(
    new PointerEvent('pointermove', { clientX: x, clientY: y, pointerId: 1, bubbles: true }),
  );
}
function up(h: Harness, x: number, y: number, o: Partial<PointerEventInit> = {}): void {
  h.canvas.dispatchEvent(
    new PointerEvent('pointerup', {
      clientX: x,
      clientY: y,
      button: 0,
      pointerId: 1,
      bubbles: true,
      ...o,
    }),
  );
  h.flush();
}

/** A press at `p`, moves through `path`, released at its last point (or `p`). */
function press(h: Harness, p: { x: number; y: number }, path: { x: number; y: number }[] = []) {
  down(h, p.x, p.y);
  for (const q of path) move(h, q.x, q.y);
  const end = path.at(-1) ?? p;
  up(h, end.x, end.y);
}

const ts = Array.from({ length: 61 }, (_, i) => i * 1_000);
/** k1 at 30, k2 at 10; NaN for both at sample `gap` (none when −1). */
function twoLines(gap = -1): FrameData {
  const v = (c: number) => ts.map((_, i) => (i === gap ? NaN : c));
  return seriesData(seriesFrame(K1, ts, v(30)), seriesFrame(K2, ts, v(10)));
}

describe('unit:engine-select', () => {
  it('line: the row nearest the pointer y at the snapped time', () => {
    const { h, sel } = frame(LINE, twoLines());
    const s = last(h);
    const x = xOf(s, 30_000);
    const y2 = yOf(s, 10);
    const y1 = yOf(s, 30);
    expect(y2 - y1).toBeGreaterThan(20);
    press(h, { x, y: y2 - 10 });
    expect(sel).toEqual([
      { source: 'pointer', item: { kind: 'point', key: K2, tMs: 30_000, value: 10 } },
    ]);
    press(h, { x, y: y1 + 5 });
    expect(sel[1]?.item).toEqual({ kind: 'point', key: K1, tMs: 30_000, value: 30 });
  });

  it('travel: < 4 px Euclidean is a click; 4 px, (3, 3), out and back and a drag are not', () => {
    const { h, sel } = frame(LINE, twoLines());
    const s = last(h);
    const p = { x: xOf(s, 30_000), y: yOf(s, 10) };
    press(h, p, [{ x: p.x, y: p.y + 3 }]);
    expect(sel).toHaveLength(1);
    press(h, p, [{ x: p.x + 2, y: p.y + 2 }]);
    expect(sel).toHaveLength(2);
    press(h, p, [{ x: p.x, y: p.y + 4 }]);
    press(h, p, [{ x: p.x + 3, y: p.y + 3 }]);
    press(h, p, [
      { x: p.x + 10, y: p.y },
      { x: p.x, y: p.y },
    ]);
    press(h, p, [{ x: p.x + 10, y: p.y }]);
    expect(sel).toHaveLength(2);
  });

  it('a gap at the snapped time: item null', () => {
    const { h, sel } = frame(LINE, twoLines(30));
    const s = last(h);
    press(h, { x: xOf(s, 30_000), y: yOf(s, 10) });
    expect(sel).toEqual([{ source: 'pointer', item: null }]);
  });

  it('Shift and the middle button are not clicks', () => {
    const { h, sel } = frame(LINE, twoLines());
    const s = last(h);
    const p = { x: xOf(s, 30_000), y: yOf(s, 10) };
    down(h, p.x, p.y, { shiftKey: true });
    up(h, p.x, p.y);
    down(h, p.x, p.y, { button: 1 });
    up(h, p.x, p.y, { button: 1 });
    expect(sel).toHaveLength(0);
  });

  const bars = (o: Partial<Extract<VisSpec, { kind: 'bars' }>> = {}): VisSpec => ({
    kind: 'bars',
    title: 'T',
    unit: NONE,
    stacking: 'normal',
    categoryLabel: 'level',
    categoryOrder: ['a', 'b', 'c'],
    ...o,
  });

  it('bars: the segment containing y, else the nearest edge', () => {
    const t6 = [0, 10_000, 20_000, 30_000, 40_000, 50_000];
    const one = t6.map(() => 1);
    const data = seriesData(
      seriesFrame('000000000000000a', t6, one, { level: 'a' }),
      seriesFrame('000000000000000b', t6, one, { level: 'b' }),
      seriesFrame('000000000000000c', t6, one, { level: 'c' }),
    );
    // A pinned range above the stack's top keeps 6 px above it inside the plot.
    const { h, sel } = frame(bars({ valueRange: { min: 0, max: 5 } }), data);
    const s = last(h);
    const x = xOf(s, 25_000);
    press(h, { x, y: yOf(s, 1.5) });
    expect(sel[0]?.item).toEqual({ kind: 'point', key: '000000000000000b', tMs: 20_000, value: 1 });
    press(h, { x, y: yOf(s, 3) - 6 });
    expect(sel[1]?.item).toEqual({ kind: 'point', key: '000000000000000c', tMs: 20_000, value: 1 });
  });

  it('bars: the drawn (merged) buckets, not the raw samples', () => {
    const spec = bars({ categoryOrder: ['a', 'b'], valueRange: { min: 0, max: 40 } });
    // Probe the plot width with any merged data (the pinned range fixes the label band).
    const probe = frame(
      spec,
      seriesData(
        seriesFrame(
          '000000000000000a',
          ts,
          ts.map(() => 1),
          { level: 'a' },
        ),
      ),
    );
    const cols = Math.floor(last(probe.h).plot.width);
    // Two raw samples per px column: raw 2j A=1 B=10, raw 2j+1 A=20 B=0.
    const n = 2 * cols;
    const raw = Array.from({ length: n }, (_, i) => ((i + 0.25) * 60_000) / n);
    const a = raw.map((_, i) => (i % 2 === 0 ? 1 : 20));
    const b = raw.map((_, i) => (i % 2 === 0 ? 10 : 0));
    const data = seriesData(
      seriesFrame('000000000000000a', raw, a, { level: 'a' }),
      seriesFrame('000000000000000b', raw, b, { level: 'b' }),
    );
    const { h, sel } = frame(spec, data);
    const s = last(h);
    expect(s.plot.width).toBe(last(probe.h).plot.width);
    const j = Math.floor(cols / 2);
    const x = s.plot.x + j + 0.5;
    press(h, { x, y: yOf(s, 5) });
    expect(sel[0]?.item?.kind).toBe('point');
    expect(sel[0]?.item).toMatchObject({ key: '000000000000000a', value: 21 });
  });

  it('heatmap: the bucket under the pointer, by bound index', () => {
    const cols = [0, 10_000, 20_000, 30_000, 40_000, 50_000];
    const bounds = [1, 2, 3, Infinity];
    const data: FrameData = {
      kind: 'heatmap',
      heatmap: {
        timestamps: new Float64Array(cols),
        bounds: new Float64Array(bounds),
        counts: new Float64Array(cols.length * bounds.length).fill(1),
      },
    };
    const spec: VisSpec = { kind: 'heatmap', title: 'H', unit: NONE, countUnit: NONE };
    const { h, sel } = frame(spec, data);
    const s = last(h);
    const x = xOf(s, 25_000);
    // Find a y whose hover row is bucket 2.
    let y2: number | null = null;
    for (let y = s.plot.y; y <= s.plot.y + s.plot.height && y2 === null; y += 1) {
      move(h, x, y);
      h.flush();
      if (h.hover.at(-1)?.rows[0]?.key === '2') y2 = y;
    }
    expect(y2).not.toBeNull();
    press(h, { x, y: y2 ?? 0 });
    expect(sel.at(-1)?.item).toEqual({
      kind: 'bucket',
      index: 2,
      tMs: 20_000,
      toMs: 30_000,
      count: 1,
    });
  });
});
