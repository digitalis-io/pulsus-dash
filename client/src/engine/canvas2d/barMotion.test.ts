/**
 * The bar fill and motion: the eased grow-in from the baseline, the hover emphasis, reduced motion,
 * forced colours (plain fills) and the time bars' narrow flat fill.
 */
import { describe, expect, it } from 'vitest';
import type { BarchartSpec, FrameData, VisSpec } from '../api';
import { EMPTY_COVERAGE } from '../../data/frames';
import { motion, radius, seriesPalette } from '../../styles/tokens';
import { fkey, row } from '../../test/categoryFixtures';
import { barFills } from '../../test/barFills';
import { harness, pointer, seriesData, seriesFrame } from '../../test/engineHarness';
import { recordingContext } from '../../test/recordingContext';
import { BASE_ALPHA, fillBar, lighten } from './barFill';
import { BarMotion, cubicBezier, easingOf, HOVER_DIM } from './barMotion';
import { Canvas2DEngine } from './Canvas2DEngine';

const palette = new Set<string>(seriesPalette.dark);

const SPEC: BarchartSpec = {
  kind: 'barchart',
  title: 'Pods',
  unit: { kind: 'none' },
  orientation: 'vertical',
  valueLabels: true,
  ghost: false,
  anomaly: false,
};

const DATA: FrameData = {
  kind: 'categories',
  categories: [row(fkey(1), 'a', 30), row(fkey(2), 'b', 20), row(fkey(3), 'c', 10)],
  coverage: EMPTY_COVERAGE,
};

const motionOn = (q: string): boolean => q === '(prefers-color-scheme: dark)';
const reduced = (q: string): boolean => q === '(prefers-reduced-motion: reduce)';
const forced = (q: string): boolean =>
  q === '(forced-colors: active)' || q === '(prefers-reduced-motion: reduce)';

function show(media: (q: string) => boolean, spec: VisSpec = SPEC, data: FrameData = DATA) {
  const h = harness(Canvas2DEngine, { clockNow: true, media });
  h.frame.setSpec(spec);
  h.frame.setData(data);
  h.frame.setTimeWindow({ fromMs: 0, toMs: 3_000 });
  h.frame.resize(400, 240, 1);
  h.flush();
  return h;
}

/** The last drawn layer's bar heights (a flush may draw several frames at one clock time). */
const heights = (h: ReturnType<typeof show>) =>
  barFills(h.layer(), palette)
    .slice(-3)
    .map((b) => b.args[3]);

describe('unit:bar-motion', () => {
  it('eases on the motion tokens', () => {
    const e = easingOf(motion['easing-spring']);
    expect(e(0)).toBe(0);
    expect(e(1)).toBe(1);
    expect(e(0.5)).toBeGreaterThan(0.8);
    const linear = cubicBezier(0, 0, 1, 1);
    expect(linear(0.3)).toBeCloseTo(0.3, 4);
  });

  it('grows the bars from the baseline over zoom-open ms, then stops redrawing', () => {
    const h = show(motionOn);
    const first = heights(h);
    expect(first.every((x) => x === 0 || x < 1)).toBe(true);
    h.layer().clearOps();
    h.advance(motion['zoom-open'] / 2);
    h.flush();
    const mid = heights(h);
    h.layer().clearOps();
    h.advance(motion['zoom-open']);
    h.flush();
    const end = heights(h);
    expect(mid).toHaveLength(3);
    expect(end).toHaveLength(3);
    mid.forEach((m, k) => {
      expect(m).toBeGreaterThan(0);
      expect(m).toBeLessThan(end[k] ?? 0);
    });
    expect(h.queued()).toBe(0);
  });

  it('new data grows again; the same data does not', () => {
    const h = show(motionOn);
    h.advance(1_000);
    h.flush();
    h.layer().clearOps();
    h.frame.setData({ ...DATA, categories: [...DATA.categories] });
    h.flush();
    expect(heights(h).every((x) => x > 1)).toBe(true);
    h.layer().clearOps();
    h.frame.setData({ ...DATA, categories: [row(fkey(1), 'a', 5)] });
    h.flush();
    expect(heights(h).every((x) => x < 1)).toBe(true);
  });

  it('lands at once under reduced motion', () => {
    const h = show(reduced);
    expect(heights(h).every((x) => x > 1)).toBe(true);
    expect(h.queued()).toBe(0);
  });

  it('the hover eases the other bars to HOVER_DIM over the hover duration', () => {
    const h = show(motionOn);
    h.advance(1_000);
    h.flush();
    const s = h.a11y.at(-1);
    if (s === undefined) throw new Error('no summary');
    const x = s.plot.x + s.plot.width / 6;
    h.layer().clearOps();
    pointer(h.canvas, 'pointermove', x, s.plot.y + s.plot.height / 2);
    h.flush();
    h.layer().clearOps();
    h.advance(motion.hover / 2);
    h.flush();
    const mid = barFills(h.layer(), palette)
      .slice(-3)
      .map((b) => b.globalAlpha);
    expect(mid[0]).toBe(1);
    expect(mid[1]).toBeGreaterThan(HOVER_DIM);
    expect(mid[1]).toBeLessThan(1);
    h.layer().clearOps();
    h.advance(motion.hover);
    h.flush();
    expect(
      barFills(h.layer(), palette)
        .slice(-3)
        .map((b) => b.globalAlpha),
    ).toEqual([1, HOVER_DIM, HOVER_DIM]);
  });

  it('forced colours: plain fills, no gradient', () => {
    const h = show(forced);
    const fills = barFills(h.layer(), palette);
    expect(fills).toHaveLength(3);
    expect(fills.every((b) => !b.gradient)).toBe(true);
    expect(h.layer().calls('createLinearGradient')).toEqual([]);
  });

  it('BarMotion without a hover is 1 for every key', () => {
    const m = new BarMotion(() => false);
    expect(m.alphaOf('k', 0)).toBe(1);
    expect(m.setHover('k', ['k', 'j'], 0)).toBe(true);
    expect(m.setHover('k', ['k', 'j'], 0)).toBe(false);
    expect(m.alphaOf('j', 10_000)).toBe(HOVER_DIM);
  });
});

describe('unit:bar-fill', () => {
  it('a gradient from the value end at full alpha to BASE_ALPHA, and a lighter value edge', () => {
    const ctx = recordingContext();
    fillBar(ctx, { x: 10, y: 20, w: 12, h: 50 }, 'top', '#3F6FA8', radius.tag, false);
    expect(ctx.calls('createLinearGradient')[0]?.args).toEqual([0, 20, 0, 70]);
    expect(ctx.calls('addColorStop').map((o) => o.args)).toEqual([
      [0, '#3F6FA8FF'],
      [
        1,
        `#3F6FA8${Math.round(BASE_ALPHA * 255)
          .toString(16)
          .toUpperCase()}`,
      ],
    ]);
    expect(ctx.calls('arc')).toHaveLength(2);
    const edge = ctx.calls('fillRect')[0];
    expect(edge?.args).toEqual([13, 20, 6, 1]);
    expect(edge?.fillStyle.slice(0, 7)).toBe(lighten('#3F6FA8', 0.35));
  });

  it('lighten mixes toward white', () => {
    expect(lighten('#000000', 0.5)).toBe('#808080');
    expect(lighten('#FFFFFF', 0.5)).toBe('#FFFFFF');
  });
});

describe('unit:time-bars-fill', () => {
  const BARS: VisSpec = {
    kind: 'bars',
    title: 'T',
    unit: { kind: 'none' },
    stacking: 'normal',
    categoryLabel: 'level',
    categoryOrder: [],
  };

  it('wide bars: gradient with a rounded top; narrow ones: one flat fill below full alpha', () => {
    const wide = show(motionOn, BARS, seriesData(seriesFrame('1', [0, 1_000, 2_000], [3, 4, 5])));
    const w = barFills(wide.layer(), palette);
    expect(w).toHaveLength(3);
    expect(w.every((b) => b.gradient)).toBe(true);
    expect(wide.layer().calls('arc').length).toBe(6);

    const ts = Array.from({ length: 300 }, (_, i) => i * 10);
    const narrow = show(
      motionOn,
      BARS,
      seriesData(
        seriesFrame(
          '1',
          ts,
          ts.map(() => 2),
        ),
      ),
    );
    const n = narrow
      .layer()
      .calls('fillRect')
      .filter((o) => palette.has(o.fillStyle.slice(0, 7)));
    expect(n.length).toBeGreaterThan(0);
    expect(n.every((o) => o.fillStyle.length === 9 && !o.fillStyle.endsWith('FF'))).toBe(true);
  });
});
