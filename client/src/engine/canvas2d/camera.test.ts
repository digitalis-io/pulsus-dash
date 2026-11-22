import { describe, expect, it } from 'vitest';
import { MAX_WINDOW_MS } from '../../state/contextReducer';
import { contain, panBy, timeLimits, toWindow, zoomAbout, type Span } from './camera';

/** One unit in the last place of `v`. */
const ulp = (v: number): number => 2 ** (Math.floor(Math.log2(Math.abs(v))) - 52);
const anchorOf = (s: Span, f: number): number => s.lo + f * (s.hi - s.lo);
const T = Date.UTC(2026, 10, 19, 12);
const UPPER = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

describe('zoomAbout, panBy, contain', () => {
  const L = timeLimits(740);
  const widths = [1_000, 3_600_000, MAX_WINDOW_MS];
  const fs = [0, 0.3, 1];
  const factors = [0.5, 1.221, 1e-6];
  it('every width, anchor fraction and factor keeps the anchor (f64, plot px, whole ms)', () => {
    for (const w of widths) {
      for (const f of fs) {
        for (const factor of factors) {
          const what = `width ${String(w)}, f ${String(f)}, factor ${String(factor)}`;
          const s: Span = { lo: 1.7e12, hi: 1.7e12 + w };
          const a = anchorOf(s, f);
          const z = zoomAbout(s, f, factor, L);
          const span = z.hi - z.lo;
          const floor = factor < 1 ? Math.min(w, L.minSpan) : L.minSpan;
          expect(span, what).toBeCloseTo(Math.min(Math.max(w * factor, floor), L.maxSpan), 3);
          // (a) numeric, (b) plot scale on 800 px.
          expect(Math.abs(anchorOf(z, f) - a), what).toBeLessThanOrEqual(
            8 * ulp(Math.max(Math.abs(z.lo), Math.abs(z.hi))),
          );
          expect((Math.abs(anchorOf(z, f) - a) * 800) / span, what).toBeLessThan(1);
          // (c) the whole-ms window keeps the anchor within one px.
          const win = toWindow(z);
          expect(Number.isInteger(win.fromMs) && Number.isInteger(win.toMs), what).toBe(true);
          const a2 = win.fromMs + f * (win.toMs - win.fromMs);
          expect((Math.abs(a2 - a) * 800) / span, what).toBeLessThan(1);
        }
      }
    }
  });

  it('clamps the width at 1 000 ms and MAX_WINDOW_MS', () => {
    const s: Span = { lo: 1.7e12, hi: 1.7e12 + 4_000 };
    const z = zoomAbout(s, 0.3, 1e-6, L);
    expect(z.hi - z.lo).toBeCloseTo(1_000, 6);
    const big: Span = { lo: 1.7e12, hi: 1.7e12 + MAX_WINDOW_MS / 2 };
    const o = zoomAbout(big, 0.3, 4, L);
    expect(o.hi - o.lo).toBeCloseTo(MAX_WINDOW_MS, 0);
  });

  it('contain shifts a span inside 0 and the upper bound', () => {
    expect(contain({ lo: -500, hi: 1_500 }, L)).toEqual({ lo: 0, hi: 2_000 });
    expect(contain({ lo: UPPER - 1_000, hi: UPPER + 1_000 }, L)).toEqual({
      lo: UPPER - 2_000,
      hi: UPPER,
    });
    const z = zoomAbout({ lo: 0, hi: 2_000 }, 0, 2, L);
    expect(z).toEqual({ lo: 0, hi: 4_000 });
    expect(panBy({ lo: 1_000, hi: 3_000 }, -1, L)).toEqual({ lo: 0, hi: 2_000 });
    expect(panBy({ lo: UPPER - 3_000, hi: UPPER - 1_000 }, 2, L)).toEqual({
      lo: UPPER - 2_000,
      hi: UPPER,
    });
  });

  it('panBy shifts by a fraction of the width', () => {
    expect(panBy({ lo: T, hi: T + 3_600_000 }, 0.1, L)).toEqual({
      lo: T + 360_000,
      hi: T + 3_960_000,
    });
  });
});

describe('timeLimits and the zoom floor', () => {
  it('minSpan follows the plot width; a sub-minimum window never widens on zoom-in', () => {
    expect(timeLimits(740).minSpan).toBe(1_000);
    expect(timeLimits(3_939.2).minSpan).toBe(3_940);
    expect(timeLimits(740).maxSpan).toBe(MAX_WINDOW_MS);
    const L = timeLimits(740);
    const s: Span = { lo: T, hi: T + 500 };
    const zin = zoomAbout(s, 0.3, 0.5, L);
    expect(zin.hi - zin.lo).toBe(500);
    const zout = zoomAbout(s, 0.3, 2, L);
    expect(zout.hi - zout.lo).toBeCloseTo(1_000, 6);
    expect(Math.abs(anchorOf(zout, 0.3) - anchorOf(s, 0.3))).toBeLessThanOrEqual(8 * ulp(T));
    const W = timeLimits(3_939.2);
    const s2: Span = { lo: T, hi: T + 2_000 };
    expect(zoomAbout(s2, 0.3, 0.5, W)).toBe(s2);
    expect(panBy(s2, 0.0047, W, 1)).toEqual({ lo: T + 9, hi: T + 2_009 });
    expect(panBy({ lo: 5, hi: 2_005 }, -0.5, W, 1)).toEqual({ lo: 0, hi: 2_000 });
  });
});

describe('worst-case rounding on a wide chart', () => {
  it('drifts at most 0.5 px with the width-dependent minimum', () => {
    const W = 3_940;
    const L = timeLimits(W);
    const z = zoomAbout({ lo: T, hi: T + 3 * W + 1 }, 0.5, 1e-6, L);
    expect(z).toEqual({ lo: T + W + 0.5, hi: T + 2 * W + 0.5 });
    const win = toWindow(z);
    expect(win).toEqual({ fromMs: T + W + 1, toMs: T + 2 * W + 1 });
    const a = T + 1.5 * W + 0.5;
    const drift = Math.abs(((a - win.fromMs) / (win.toMs - win.fromMs)) * W - W / 2);
    expect(drift).toBeCloseTo(0.5, 9);
    // A fixed 1 000 ms minimum drifts 1.97 px on the same chart.
    const fixed = zoomAbout({ lo: T, hi: T + 3 * W + 1 }, 0.5, 1e-6, { ...L, minSpan: 1_000 });
    const w2 = toWindow(fixed);
    const d2 = Math.abs(((a - w2.fromMs) / (w2.toMs - w2.fromMs)) * W - W / 2);
    expect(d2).toBeCloseTo(1.97, 2);
  });
});
