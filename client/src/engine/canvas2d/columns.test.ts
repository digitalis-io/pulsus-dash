import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../test/random';
import { recordingContext } from '../../test/recordingContext';
import { lineColumns, mergeBuckets, type Column } from './columns';
import { drawLineSeries } from './draw';

interface Expected {
  min: number;
  max: number;
  last: number;
  minMs: number;
  maxMs: number;
  lastMs: number;
  count: number;
}

/** Brute force: the finite samples of each column, first occurrence of each extreme. */
function expected(ts: Float64Array, vs: Float64Array, from: number, to: number, width: number) {
  const out: (Expected | null)[] = Array.from({ length: width }, () => null);
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i] ?? 0;
    const v = vs[i] ?? NaN;
    if (t < from || t > to || !Number.isFinite(v)) continue;
    const x = Math.min(width - 1, Math.max(0, Math.floor(((t - from) / (to - from)) * width)));
    const c = out[x];
    if (c === null || c === undefined) {
      out[x] = { min: v, max: v, last: v, minMs: t, maxMs: t, lastMs: t, count: 1 };
      continue;
    }
    if (v < c.min) {
      c.min = v;
      c.minMs = t;
    }
    if (v > c.max) {
      c.max = v;
      c.maxMs = t;
    }
    c.last = v;
    c.lastMs = t;
    c.count += 1;
  }
  return out;
}

describe('unit:columns', () => {
  it('keeps every raw extreme and at most two vertices (first, last) per column', () => {
    const r = mulberry32(60);
    for (let s = 0; s < 100; s++) {
      const n = 1_440;
      const ts = new Float64Array(n);
      const vs = new Float64Array(n);
      let nanLeft = 0;
      for (let i = 0; i < n; i++) {
        ts[i] = i * 2_500;
        if (nanLeft === 0 && r() < 0.01) nanLeft = 1 + Math.floor(r() * 40);
        vs[i] = nanLeft > 0 ? NaN : r() * 100 - 20;
        if (nanLeft > 0) nanLeft -= 1;
      }
      const width = 200 + Math.floor(r() * 1_200);
      const plot = { x: 10, y: 0, width, height: 100 };
      const w = { fromMs: 0, toMs: (n - 1) * 2_500 };
      const cols = lineColumns(ts, vs, w, plot);
      const want = expected(ts, vs, w.fromMs, w.toMs, width);
      expect(cols.length).toBe(width);
      cols.forEach((c, x) => {
        const e = want[x];
        if (e === null || e === undefined) {
          expect(c, `series ${String(s)} column ${String(x)}`).toBeNull();
          return;
        }
        expect(c).not.toBeNull();
        const { min, max, last, minMs, maxMs, lastMs, count } = c as Column;
        expect({ min, max, last, minMs, maxMs, lastMs, count }).toEqual(e);
        expect((c as Column).x).toBe(x);
      });
      const ctx = recordingContext();
      drawLineSeries(ctx, cols, plot, (v) => 100 - v, '#7AA2D6', 1.5);
      const vertices = ctx.ops.filter(
        (o) => o.op === 'moveTo' || o.op === 'lineTo' || o.op === 'arc',
      );
      // #282 Part 2b: a vertex at a column's first and at its last value (the engine's joins).
      const xs = vertices.map((o) => Math.floor(Number(o.args[0])));
      const per = new Map<number, number>();
      for (const x of xs) per.set(x, (per.get(x) ?? 0) + 1);
      expect(Math.max(0, ...per.values())).toBeLessThanOrEqual(2);
      expect(vertices.length).toBeLessThanOrEqual(2 * cols.filter((c) => c !== null).length);
    }
  });

  it('merges buckets to one per CSS px and keeps the counts', () => {
    const ts = new Float64Array(Array.from({ length: 600 }, (_, i) => i * 1_000));
    const counts = new Float64Array(Array.from({ length: 1_800 }, (_, i) => (i % 7) + 1));
    const m = mergeBuckets(
      ts,
      counts,
      3,
      { fromMs: 0, toMs: 600_000 },
      {
        x: 0,
        y: 0,
        width: 300,
        height: 100,
      },
    );
    expect(m.ts.length).toBe(300);
    expect(m.counts.length).toBe(900);
    expect(m.ts[1]).toBe(2_000);
    const sum = (a: Float64Array): number => a.reduce((x, y) => x + y, 0);
    expect(sum(m.counts)).toBe(sum(counts));
    expect(m.counts[0]).toBe((counts[0] ?? 0) + (counts[3] ?? 0));
  });

  it('merge keeps missing: a merged heatmap cell with a missing constituent is missing', () => {
    const ts = new Float64Array([0, 1000, 2000, 3000]);
    const counts = new Float64Array([1, 2, NaN, 3, 4, NaN, 6, NaN]);
    const w = { fromMs: 0, toMs: 4000 };
    const plot = { x: 0, y: 0, width: 2, height: 10 };
    const missing = mergeBuckets(ts, counts, 2, w, plot, 'missing');
    expect(Array.from(missing.ts)).toEqual([0, 2000]);
    expect(Array.from(missing.counts).map((c) => (Number.isNaN(c) ? 'NaN' : c))).toEqual([
      'NaN',
      5,
      10,
      'NaN',
    ]);
    expect(missing.endMs).toBe(4000);
    const zero = mergeBuckets(ts, counts, 2, w, plot);
    expect(Array.from(zero.counts)).toEqual([1, 5, 10, 0]);
    expect(zero.endMs).toBe(4000);
  });

  it('drops buckets outside the window instead of merging them into the edge columns', () => {
    // 30 buckets of 1 s from −10 s; window 0–9 999 ms over 5 px (2 s per column).
    const ts = new Float64Array(Array.from({ length: 30 }, (_, i) => (i - 10) * 1_000));
    const counts = new Float64Array(30).fill(1);
    const m = mergeBuckets(
      ts,
      counts,
      1,
      { fromMs: 0, toMs: 9_999 },
      {
        x: 0,
        y: 0,
        width: 5,
        height: 100,
      },
    );
    expect([...m.ts]).toEqual([0, 2_000, 4_000, 6_000, 8_000]);
    expect([...m.counts]).toEqual([2, 2, 2, 2, 2]);
  });

  it('keeps a bucket that overlaps the window edge, clipped to the window', () => {
    // 3 000 one-second buckets; only bucket 100 (100–101 s) overlaps the left window.
    const ts = new Float64Array(Array.from({ length: 3_000 }, (_, i) => i * 1_000));
    const counts = new Float64Array(Array.from({ length: 3_000 }, (_, i) => i));
    const plot = { x: 0, y: 0, width: 10, height: 100 };
    const left = mergeBuckets(ts, counts, 1, { fromMs: 100_200, toMs: 100_800 }, plot);
    expect([...left.ts]).toEqual([100_200]);
    expect([...left.counts]).toEqual([100]);
    expect(left.endMs).toBe(100_800);
    // Right edge: bucket 101 starts inside and runs past the window end.
    const right = mergeBuckets(ts, counts, 1, { fromMs: 100_200, toMs: 101_500 }, plot);
    expect([...right.ts]).toEqual([100_200, 101_000]);
    expect([...right.counts]).toEqual([100, 101]);
    expect(right.endMs).toBe(101_500);
  });

  describe('cases', () => {
    // Window 0–1 000 ms over 10 px: column = floor(t / 100).
    const w = { fromMs: 0, toMs: 1_000 };
    const plot = { x: 0, y: 0, width: 10, height: 100 };
    const y = (v: number): number => 100 - 10 * v;
    const column = (vs: number[], before: number[] = []): Column => {
      const ts = [...before.map((_, i) => 50 + i), ...vs.map((_, i) => 100 + 10 * i)];
      const cols = lineColumns(new Float64Array(ts), new Float64Array([...before, ...vs]), w, plot);
      const c = cols[1];
      if (c === null || c === undefined) throw new Error('column 1 is empty');
      return c;
    };

    it('(a) min before max and (b) max before min', () => {
      const a = column([5, 1, 9, 3]);
      expect(a.minMs).toBeLessThan(a.maxMs);
      expect([a.min, a.max, a.last]).toEqual([1, 9, 3]);
      const b = column([5, 9, 1, 3]);
      expect(b.maxMs).toBeLessThan(b.minMs);
      expect([b.min, b.max, b.last]).toEqual([1, 9, 3]);
    });

    it('(c) a NaN inside a column breaks the path and splits the span', () => {
      const ts = new Float64Array([50, 100, 110, 120, 130, 140]);
      const vs = new Float64Array([1, 2, 4, NaN, 6, 8]);
      const cols = lineColumns(ts, vs, w, plot);
      const c = cols[1];
      expect(c?.breakBefore).toBe(true);
      expect(c?.runs.map((r) => [r.min, r.max])).toEqual([
        [2, 4],
        [6, 8],
      ]);
      const ctx = recordingContext();
      drawLineSeries(ctx, cols, plot, y, '#7AA2D6', 1.5);
      const rects = ctx.calls('fillRect').filter((o) => o.args[0] === 1);
      expect(rects.map((o) => o.args)).toEqual([
        [1, y(4), 1, y(2) - y(4)],
        [1, y(8), 1, y(6) - y(8)],
      ]);
      // No rect covers the gap (4, 6).
      for (const o of rects) {
        const top = Number(o.args[1]);
        const bottom = top + Number(o.args[3]);
        expect(top >= y(4) || bottom <= y(6)).toBe(true);
      }
      const path = ctx.ops.filter((o) => ['moveTo', 'lineTo'].includes(o.op));
      // #282 Part 2b: the NaN lies after column 1's first sample, so column 0 joins it; the line
      // breaks inside column 1 (a move to its last).
      expect(path.map((o) => [o.op, ...o.args])).toEqual([
        ['moveTo', 0.5, y(1)],
        ['lineTo', 0.5, y(1)],
        ['lineTo', 1.5, y(2)],
        ['moveTo', 1.5, y(8)],
      ]);
    });
  });
});

describe('lineColumns join flags (#282 Part 2b §4.2, unit:canvas-joins)', () => {
  const w = { fromMs: 0, toMs: 400 };
  const plot = { x: 0, y: 0, width: 400, height: 100 };
  it('records first, gapLead and gapInner per drawn column', () => {
    const ts = new Float64Array([100.5, 200.1, 200.5, 200.9, 300.5]);
    const vs = new Float64Array([30, 60, NaN, 40, 50]);
    const cols = lineColumns(ts, vs, w, plot);
    const c = cols[200];
    expect([c?.first, c?.last, c?.gapLead, c?.gapInner]).toEqual([60, 40, false, true]);
    expect([cols[300]?.first, cols[300]?.gapLead, cols[300]?.gapInner]).toEqual([50, false, false]);
    const lead = lineColumns(
      new Float64Array([10.5, 20.2, 20.6]),
      new Float64Array([1, NaN, 2]),
      w,
      plot,
    );
    expect([lead[20]?.gapLead, lead[20]?.gapInner]).toEqual([true, false]);
  });
});
