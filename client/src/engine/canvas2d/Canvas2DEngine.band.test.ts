/**
 * `describe('camera')` of plan #93 §5.1 and Appendix A §A.12–A.13 (F2): the held value-label band,
 * compact and chipped labels, the minimum band, its release rows, and the manual value axis.
 */
import { describe, expect, it } from 'vitest';
import type { FrameSummary, TimeWindow, VisSpec } from '../api';
import { formatCompact, formatValue, type Unit } from '../../i18n/format';
import { LABEL_HEIGHT } from './layout';
import { valueTicks } from './valueTicks';
import { pointer, seriesData, seriesFrame, wheel, type Harness } from '../../test/engineHarness';
import { CHAR_WIDTH, recordingContext } from '../../test/recordingContext';
import { minValueBand } from './draw';
import {
  KEY,
  T0,
  T1,
  NONE,
  LINE,
  GAP_X,
  lineData,
  setup,
  present,
  range,
  last,
  xOf,
  tAt,
  axisOf,
  yOf,
  vAt,
  winOf,
  labels,
  tickValues,
  CHIP,
  heldText,
  step,
  measuredX,
  at,
  type Label,
} from '../../test/cameraKit';

describe('camera', () => {
  it('band held through a time zoom on bars', () => {
    // One-second buckets (deviation: with one-minute buckets no zoom of this window merges).
    const PCT: Unit = { kind: 'percent' };
    const spec: VisSpec = {
      kind: 'bars',
      title: 'T',
      unit: PCT,
      stacking: 'normal',
      categoryLabel: 'level',
      categoryOrder: ['info'],
    };
    const ts = Array.from({ length: 3_600 }, (_, i) => T0 + i * 1_000);
    const data = seriesData(
      seriesFrame(
        KEY,
        ts,
        ts.map(() => 300_000),
        { level: 'info' },
      ),
    );
    const w = { fromMs: T0 + 25 * 60_000, toMs: T0 + 35 * 60_000 };
    const h = setup({ spec, data, w });
    const s0 = last(h);
    const band = s0.plot.x - GAP_X;
    const p = at(s0, 0.2);
    let ta = 0;
    let compact = 0;
    const check = (l: Label[], s: FrameSummary): void => {
      expect(s.plot.x).toBe(s0.plot.x);
      expect(s.plot.width).toBe(s0.plot.width);
      const ticks = tickValues(s, l);
      l.forEach((x, k) => {
        const t = ticks[k] ?? NaN;
        expect(x.text).toBe(heldText(t, PCT, band).text);
        expect(x.chip).toBe(false);
        if (x.text !== formatValue(t, PCT)) compact += 1;
        expect(x.left).toBeGreaterThanOrEqual(0);
        expect(x.right).toBeLessThanOrEqual(s.plot.x);
      });
    };
    for (let i = 0; i < 10; i++) {
      ta = tAt(last(h), p.x);
      const { s, l } = step(h, () => {
        wheel(h.canvas, p.x, p.y, { deltaY: 300 });
      });
      check(l, s);
    }
    expect(measuredX(spec, data, winOf(last(h)), null) - s0.plot.x).toBeGreaterThanOrEqual(2);
    expect(compact).toBeGreaterThan(0);
    const { s, l } = step(h, () => {
      h.advance(300);
    });
    check(l, s);
    expect(Math.abs(xOf(s, ta) - p.x)).toBeLessThan(1);
  });

  it.each([
    ['positive', 0, 30, 1, 1e-5, '10µ', '0.00001'],
    ['negative', -30, 0, 0, -1e-5, '-10µ', '-0.00001'],
  ] as const)(
    'wider labels during a Y-only zoom, %s',
    (_name, lo, hi, fromTop, tick, compactText, fullText) => {
      const h = setup({ data: lineData(lo, hi) });
      const s0 = last(h);
      const plot0 = s0.plot;
      expect(plot0.x - GAP_X).toBe(42);
      const p = at(s0, 0.3, fromTop);
      const ta = tAt(s0, p.x);
      const va = vAt(s0, p.y);
      expect(va).toBeCloseTo(0, 12);
      const frames: { s: FrameSummary; l: Label[] }[] = [];
      for (let i = 0; i < 18; i++) {
        frames.push(
          step(h, () => {
            wheel(h.canvas, p.x, p.y, { deltaY: -1000, shiftKey: true });
          }),
        );
      }
      frames.push(
        step(h, () => {
          h.advance(300);
        }),
      );
      expect(h.commit).toHaveLength(1);
      const c = h.commit[0];
      expect(c).toMatchObject({ window: null, gesture: 'wheel' });
      const value = range(c?.value);
      frames.push(
        step(h, () => {
          h.frame.setSpec({ ...LINE, valueRange: value });
        }),
      );
      const final = present(frames.at(-1), 'frame');
      expect(measuredX(LINE, lineData(lo, hi), winOf(final.s), value) - plot0.x).toBeGreaterThan(0);
      for (const { s, l } of frames) {
        expect(s.plot.x).toBe(plot0.x);
        expect(s.plot.width).toBe(plot0.width);
        expect(Math.abs(xOf(s, ta) - p.x)).toBeLessThan(1);
        expect(Math.abs(yOf(s, va) - p.y)).toBeLessThan(1);
        for (const x of l) {
          expect(x.text.length).toBeLessThanOrEqual(6);
          expect(x.left).toBeGreaterThanOrEqual(0);
          expect(x.right).toBeLessThanOrEqual(s.plot.x);
        }
      }
      const at1e5 = (l: Label[], s: FrameSummary) =>
        l.find((x) => Math.abs(x.y - yOf(s, tick)) < 1e-6)?.text;
      expect(at1e5(final.l, final.s)).toBe(compactText);
      const after = step(h, () => {
        h.canvas.dispatchEvent(new PointerEvent('pointerleave'));
      });
      expect(after.s.plot.x).toBeGreaterThan(plot0.x);
      expect(after.s.plot.x).toBe(measuredX(LINE, lineData(lo, hi), winOf(after.s), value));
      expect(at1e5(after.l, after.s)).toBe(fullText);
    },
  );

  it.each([
    ['positive', 0, 2e-5, 2e-5, '20µ', '0.00002'],
    ['negative', -2e-5, 0, -2e-5, '-20µ', '-0.00002'],
  ] as const)(
    'wider labels after the refetch, %s',
    (_name, lo, hi, tick, compactText, fullText) => {
      const h = setup();
      const s0 = last(h);
      const p = at(s0, 0.3);
      const ta = tAt(s0, p.x);
      for (let i = 0; i < 4; i++) wheel(h.canvas, p.x, p.y, { deltaY: -300 });
      h.flush();
      h.advance(300);
      const c = present(h.commit[0]?.window, 'commit');
      h.frame.setTimeWindow(c);
      const data = lineData(lo, hi);
      const r = step(h, () => {
        h.frame.setData(data);
      });
      expect(measuredX(LINE, data, c, null) - s0.plot.x).toBeGreaterThanOrEqual(2);
      expect(r.s.plot.x).toBe(s0.plot.x);
      expect(r.s.plot.width).toBe(s0.plot.width);
      expect(winOf(r.s)).toEqual(c);
      expect(Math.abs(xOf(r.s, ta) - p.x)).toBeLessThan(1);
      expect(r.l.find((x) => Math.abs(x.y - yOf(r.s, tick)) < 1e-6)?.text).toBe(compactText);
      for (const x of r.l) {
        expect(x.left).toBeGreaterThanOrEqual(0);
        expect(x.right).toBeLessThanOrEqual(r.s.plot.x);
      }
      const idle = step(h, () => {
        h.frame.setTimeWindow({ fromMs: T1, toMs: T1 + 3_600_000 });
      });
      expect(idle.s.plot.x).toBe(measuredX(LINE, data, winOf(idle.s), null));
      expect(idle.l.find((x) => Math.abs(x.y - yOf(idle.s, tick)) < 1e-6)?.text).toBe(fullText);
    },
  );

  it('minimum band when idle', () => {
    const ctx = recordingContext();
    expect(minValueBand(ctx, NONE)).toBe(42);
    expect(minValueBand(ctx, { kind: 'time', base: 'ms' })).toBe(56);
    const line = setup();
    expect(last(line).plot.x - GAP_X).toBe(42);
    const ms = setup({ spec: { ...LINE, unit: { kind: 'time', base: 'ms' } } });
    expect(last(ms).plot.x - GAP_X).toBe(56);
    const stat = setup({ spec: { kind: 'stat', title: 'T', unit: NONE } });
    expect(last(stat).plot.x).toBe(0);
  });

  describe('band hold releases', () => {
    const small = lineData(0, 2e-5);
    /** A frame whose hold (42 px) is set by a committed wheel, then shown data 0…2e-5. */
    function held(): { h: Harness; x0: number; base: TimeWindow; p: { x: number; y: number } } {
      const h = setup();
      const s0 = last(h);
      const p = at(s0, 0.3);
      wheel(h.canvas, p.x, p.y, { deltaY: -300 });
      h.flush();
      h.advance(300);
      const base = present(h.commit[0]?.window, 'commit');
      h.frame.setTimeWindow(base);
      h.frame.setData(small);
      h.flush();
      expect(last(h).plot.x).toBe(s0.plot.x);
      expect(measuredX(LINE, small, base, null) - s0.plot.x).toBeGreaterThanOrEqual(7);
      return { h, x0: s0.plot.x, base, p };
    }
    it.each([
      [
        'resize',
        (f: ReturnType<typeof held>) => {
          f.h.frame.resize(600, 240, 1);
        },
        (f: ReturnType<typeof held>) => measuredX(LINE, small, f.base, null, 600),
      ],
      [
        'setSpec bars',
        (f: ReturnType<typeof held>) => {
          f.h.frame.setSpec({
            kind: 'bars',
            title: 'T',
            unit: NONE,
            stacking: 'normal',
            categoryLabel: 'level',
            categoryOrder: [],
          });
        },
        (f: ReturnType<typeof held>) =>
          measuredX(
            {
              kind: 'bars',
              title: 'T',
              unit: NONE,
              stacking: 'normal',
              categoryLabel: 'level',
              categoryOrder: [],
            },
            small,
            f.base,
            null,
          ),
      ],
      [
        'setSpec unit s',
        (f: ReturnType<typeof held>) => {
          f.h.frame.setSpec({ ...LINE, unit: { kind: 'time', base: 's' } });
        },
        (f: ReturnType<typeof held>) =>
          measuredX({ ...LINE, unit: { kind: 'time', base: 's' } }, small, f.base, null),
      ],
      [
        'setSpec without valueRange',
        (f: ReturnType<typeof held>) => {
          f.h.frame.setSpec({ ...LINE, valueRange: { min: 0, max: 2e-5 } });
          f.h.flush();
          expect(last(f.h).plot.x).toBe(f.x0);
          f.h.frame.setSpec(LINE);
        },
        (f: ReturnType<typeof held>) => measuredX(LINE, small, f.base, null),
      ],
      [
        'idle setTimeWindow',
        (f: ReturnType<typeof held>) => {
          f.h.frame.setTimeWindow({ fromMs: T1, toMs: T1 + 3_600_000 });
        },
        () => measuredX(LINE, small, { fromMs: T1, toMs: T1 + 3_600_000 }, null),
      ],
      [
        'idle pointerleave',
        (f: ReturnType<typeof held>) => {
          f.h.canvas.dispatchEvent(new PointerEvent('pointerleave'));
        },
        (f: ReturnType<typeof held>) => measuredX(LINE, small, f.base, null),
      ],
    ] as const)('release: %s', (_name, act, expected) => {
      const f = held();
      act(f);
      f.h.flush();
      expect(last(f.h).plot.x).toBe(expected(f));
      expect(last(f.h).plot.x).toBeGreaterThan(f.x0);
    });

    it.each([
      [
        'pointerleave during a wheel gesture',
        (f: ReturnType<typeof held>) => {
          wheel(f.h.canvas, f.p.x, f.p.y, { deltaY: -100 });
          f.h.flush();
          f.h.canvas.dispatchEvent(new PointerEvent('pointerleave'));
        },
      ],
      [
        'setTimeWindow equal to the base',
        (f: ReturnType<typeof held>) => {
          f.h.frame.setTimeWindow(f.base);
        },
      ],
      [
        'setData ×3',
        (f: ReturnType<typeof held>) => {
          for (let i = 0; i < 3; i++) {
            f.h.frame.setData(lineData(0, 2e-5 * (1 + i / 10)));
            f.h.flush();
          }
        },
      ],
      [
        'setSpec with a new valueRange',
        (f: ReturnType<typeof held>) => {
          f.h.frame.setSpec({ ...LINE, valueRange: { min: 0, max: 3e-5 } });
        },
      ],
    ] as const)('kept: %s', (_name, act) => {
      const f = held();
      act(f);
      f.h.flush();
      expect(last(f.h).plot.x).toBe(f.x0);
    });
  });

  it('manual axis clips and ticks inside', () => {
    const h = setup({ spec: { ...LINE, valueRange: { min: 10, max: 20 } } });
    const s = last(h);
    const ops = h.layer().ops.map((o) => o.op);
    const save = ops.indexOf('save');
    expect(save).toBeGreaterThanOrEqual(0);
    expect(ops.slice(save, save + 4)).toEqual(['save', 'beginPath', 'rect', 'clip']);
    expect(ops.lastIndexOf('restore')).toBeGreaterThan(save);
    expect(h.layer().calls('rect')[0]?.args).toEqual([
      s.plot.x,
      s.plot.y,
      s.plot.width,
      s.plot.height,
    ]);
    const l = labels(h);
    expect(l.length).toBeGreaterThan(0);
    for (const x of l) {
      expect(Number(x.text)).toBeGreaterThanOrEqual(10);
      expect(Number(x.text)).toBeLessThanOrEqual(20);
    }
    expect(s.valueAxis).toEqual({ min: 10, max: 20, manual: true });
    h.visible().clearOps();
    pointer(h.canvas, 'pointermove', s.plot.x + s.plot.width, s.plot.y + 20);
    h.flush();
    expect(h.hover.at(-1)?.rows.map((r) => r.value)).toEqual([30]);
    expect(h.visible().calls('arc')).toHaveLength(0);
  });

  it('non-fitting label during a Y zoom keeps the anchor', () => {
    // Deviation from Appendix A §A.13: `valueLimits` keeps a zoom-in span ≥ 1e-9, so no tick below
    // 1e-12 is reachable. The gesture zooms out instead, about a value near the axis bottom, until
    // a tick such as 1.5e22 has no form that fits the band (`1.5e+22`, 7 characters).
    const h = setup();
    const s0 = last(h);
    const plot0 = s0.plot;
    const band = plot0.x - GAP_X;
    const p = at(s0, 0.3, 0.9);
    const ta = tAt(s0, p.x);
    const va = vAt(s0, p.y);
    const frames: { s: FrameSummary; l: Label[] }[] = [
      step(h, () => {
        wheel(h.canvas, p.x, p.y, { deltaY: -300, shiftKey: true });
      }),
    ];
    let chipped = 0;
    for (let i = 0; i < 200 && chipped === 0; i++) {
      const f = step(h, () => {
        wheel(h.canvas, p.x, p.y, { deltaY: 1000, shiftKey: true });
      });
      frames.push(f);
      chipped += f.l.filter((x) => x.chip).length;
    }
    expect(chipped).toBeGreaterThan(0);
    for (const { s, l } of frames) {
      expect(s.plot.x).toBe(plot0.x);
      expect(s.plot.width).toBe(plot0.width);
      expect(Math.abs(xOf(s, ta) - p.x)).toBeLessThan(1);
      expect(Math.abs(yOf(s, va) - p.y)).toBeLessThan(1);
      const ticks = tickValues(s, l);
      l.forEach((x, k) => {
        const want = heldText(ticks[k] ?? NaN, NONE, band, s.plot.width);
        expect(x.text).toBe(want.text);
        expect(x.chip).toBe(want.chip);
        if (want.chip) {
          expect(x.left).toBeGreaterThanOrEqual(s.plot.x);
          expect(x.right).toBeLessThanOrEqual(s.plot.x + s.plot.width);
        } else {
          expect(x.left).toBeGreaterThanOrEqual(0);
          expect(x.right).toBeLessThanOrEqual(s.plot.x);
        }
      });
    }
    h.advance(300);
    const after = step(h, () => {
      h.canvas.dispatchEvent(new PointerEvent('pointerleave'));
    });
    const axis = axisOf(after.s);
    expect(after.s.plot.x).toBe(
      measuredX(LINE, lineData(), winOf(after.s), { min: axis.min, max: axis.max }),
    );
    expect(after.l.every((x) => !x.chip && x.right <= after.s.plot.x)).toBe(true);
  });

  it('non-fitting label after the refetch keeps the anchor', () => {
    const h = setup();
    const s0 = last(h);
    const band = s0.plot.x - GAP_X;
    const p = at(s0, 0.3);
    const ta = tAt(s0, p.x);
    for (let i = 0; i < 4; i++) wheel(h.canvas, p.x, p.y, { deltaY: -300 });
    h.flush();
    h.advance(300);
    const c = present(h.commit[0]?.window, 'commit');
    h.frame.setTimeWindow(c);
    const data = lineData(0, 2e-13);
    const r = step(h, () => {
      h.frame.setData(data);
    });
    expect(r.s.plot.x).toBe(s0.plot.x);
    expect(r.s.plot.width).toBe(s0.plot.width);
    expect(winOf(r.s)).toEqual(c);
    expect(Math.abs(xOf(r.s, ta) - p.x)).toBeLessThan(1);
    const axis = axisOf(r.s);
    const ticks = [0, 5e-14, 1e-13, 1.5e-13, 2e-13].filter((t) => t >= axis.min && t <= axis.max);
    const byValue = [...r.l].sort((a, b) => b.y - a.y);
    expect(byValue.map((x) => x.text)).toEqual(ticks.map((t) => formatValue(t, NONE)));
    const wide = r.l.filter((x) => CHAR_WIDTH * x.text.length > band);
    expect(wide.length).toBeGreaterThan(0);
    for (const x of wide) {
      expect(x.chip).toBe(true);
      expect(x.left).toBeGreaterThanOrEqual(r.s.plot.x);
      expect(x.right).toBeLessThanOrEqual(r.s.plot.x + r.s.plot.width);
    }
    const idle = step(h, () => {
      h.frame.setTimeWindow({ fromMs: T1, toMs: T1 + 3_600_000 });
    });
    expect(idle.s.plot.x).toBe(measuredX(LINE, data, winOf(idle.s), null));
    expect(idle.s.plot.x).toBeGreaterThan(s0.plot.x);
    expect(idle.l.every((x) => !x.chip && x.right <= idle.s.plot.x)).toBe(true);
  });
  // Code review r1 #1: a chip on a narrow plot stays whole inside it, the plot unmoved.
  describe('non-fitting label on a narrow plot', () => {
    /** 122 px wide: a 60 px plot, too narrow for `15000000P` (63 px). */
    const NARROW = [122, 240] as const;
    const inside = (x: Label, s: FrameSummary): void => {
      expect(x.chip).toBe(true);
      expect(x.left).toBeGreaterThanOrEqual(s.plot.x);
      expect(x.right).toBeLessThanOrEqual(s.plot.x + s.plot.width);
    };

    // #208: with the out-of-range form (T21-013) a tick ≥ 1e21 reads the same in full and compact
    // form (`1.5e+21`, 49 px), so a chip whose full form is wider than the plot can no longer occur
    // (it is omitted instead). The case keeps the 60 px plot and data from −30 to 30, whose zoom-out
    // reaches chipped `1.5e+NN` ticks: wider than the band, held whole inside the plot.
    it('during a Y zoom', () => {
      const h = setup({ size: NARROW, data: lineData(-30, 30) });
      const s0 = last(h);
      expect(s0.plot.width).toBe(60);
      const band = s0.plot.x - GAP_X;
      const p = at(s0, 0.5, 0.9);
      const frames: { s: FrameSummary; l: Label[] }[] = [];
      let narrowed = 0;
      for (let i = 0; i < 200 && narrowed === 0; i++) {
        const f = step(h, () => {
          wheel(h.canvas, p.x, p.y, { deltaY: 1000, shiftKey: true });
        });
        frames.push(f);
        const ticks = f.l.length > 1 ? tickValues(f.s, f.l) : [];
        narrowed += f.l.filter(
          (x, k) => x.chip && CHAR_WIDTH * formatValue(ticks[k] ?? NaN, NONE).length > band,
        ).length;
      }
      // Some chipped tick's full form is wider than the band.
      expect(narrowed).toBeGreaterThan(0);
      for (const { s, l } of frames) {
        expect(s.plot).toEqual(s0.plot);
        const ticks = tickValues(s, l);
        l.forEach((x, k) => {
          const want = heldText(ticks[k] ?? NaN, NONE, band, s.plot.width);
          expect(x.text).toBe(want.text);
          if (want.chip) inside(x, s);
        });
      }
    });

    it('after the refetch', () => {
      const h = setup({ size: NARROW });
      const s0 = last(h);
      const p = at(s0, 0.3);
      for (let i = 0; i < 4; i++) wheel(h.canvas, p.x, p.y, { deltaY: -300 });
      h.flush();
      h.advance(300);
      const c = present(h.commit[0]?.window, 'commit');
      h.frame.setTimeWindow(c);
      const r = step(h, () => {
        h.frame.setData(lineData(0, 2e22));
      });
      expect(r.s.plot).toEqual(s0.plot);
      const chips = r.l.filter((x) => x.chip);
      expect(chips.map((x) => x.text)).toEqual(['1.5e+22']);
      for (const x of chips) inside(x, r.s);
    });

    // Code review r4 #4: fit is tested against the plot width itself; the chip padding shrinks
    // (to zero if need be) so a label that fits the plot is drawn whole inside it.
    it('boundary: a 49 px label on a 50 px plot with a 42 px band is drawn whole', () => {
      const h = setup({ size: [112, 240] });
      const s0 = last(h);
      expect(s0.plot.width).toBe(50);
      expect(s0.plot.x - GAP_X).toBe(42);
      const p = at(s0, 0.3);
      for (let i = 0; i < 4; i++) wheel(h.canvas, p.x, p.y, { deltaY: -300 });
      h.flush();
      h.advance(300);
      const c = present(h.commit[0]?.window, 'commit');
      h.frame.setTimeWindow(c);
      const r = step(h, () => {
        h.frame.setData(lineData(0, 2e22));
      });
      expect(r.s.plot).toEqual(s0.plot);
      const chips = r.l.filter((x) => x.chip);
      expect(chips.map((x) => x.text)).toEqual(['1.5e+22']);
      expect(CHAR_WIDTH * '1.5e+22'.length).toBe(49);
      for (const x of chips) inside(x, r.s);
      // The chip itself stays inside the plot too.
      for (const o of h
        .layer()
        .ops.filter((x) => x.fillStyle === CHIP && ['moveTo', 'lineTo', 'arc'].includes(x.op))) {
        const xs =
          o.op === 'arc'
            ? [Number(o.args[0]) - Number(o.args[2]), Number(o.args[0]) + Number(o.args[2])]
            : [Number(o.args[0])];
        for (const x of xs) {
          expect(x).toBeGreaterThanOrEqual(r.s.plot.x - 1e-9);
          expect(x).toBeLessThanOrEqual(r.s.plot.x + r.s.plot.width + 1e-9);
        }
      }
    });
  });
  // T02-011 (amended by #93, code review r3 and r4): "When a plot is narrower than both the full and
  // the compact form of a value label, that tick's label is omitted; its gridline remains. A label
  // is never drawn partially or outside the plot." No chip is drawn, and nothing is drawn in the
  // plot but the marks and gridlines.
  describe('non-fitting label on a plot narrower than both forms', () => {
    /** 86 px wide: a 24 px plot, 16 px of room inside the chip padding. */
    const TINY = [86, 240] as const;
    /** The layer's chip fills, and its labels outside the band (left-aligned: in the plot). */
    const inPlotText = (h: Harness): number =>
      h
        .layer()
        .calls('fillText')
        .filter((o) => o.textAlign === 'left').length;
    const chipFills = (h: Harness): number =>
      h
        .layer()
        .calls('fill')
        .filter((o) => o.fillStyle === CHIP).length;
    /** The ticks the manual or auto axis of `s` has (as draw.ts computes them). */
    const ticksOf = (s: FrameSummary): number[] => {
      const a = axisOf(s);
      const tol = 1e-9 * (a.max - a.min);
      return valueTicks(a.min, a.max, s.plot.height, LABEL_HEIGHT, 1000).ticks.filter(
        (t) => t >= a.min - tol && t <= a.max + tol,
      );
    };
    const check = (h: Harness, s0: FrameSummary, s: FrameSummary, l: Label[]): number => {
      expect(s.plot).toEqual(s0.plot);
      expect(chipFills(h)).toBe(0);
      expect(inPlotText(h)).toBe(0);
      const band = s0.plot.x - GAP_X;
      for (const x of l) {
        expect(x.chip).toBe(false);
        expect(x.left).toBeGreaterThanOrEqual(0);
        expect(x.right).toBeLessThanOrEqual(s.plot.x);
        expect(CHAR_WIDTH * x.text.length).toBeLessThanOrEqual(band);
      }
      // Ticks with no form that fits the band are left out (not chipped).
      return ticksOf(s).filter((t) => CHAR_WIDTH * formatCompact(t, NONE).length > band).length;
    };

    it('during a Y zoom', () => {
      const h = setup({ size: TINY });
      const s0 = last(h);
      expect(s0.plot.width).toBe(24);
      const p = at(s0, 0.5, 0.9);
      let omitted = 0;
      for (let i = 0; i < 200 && omitted === 0; i++) {
        const f = step(h, () => {
          wheel(h.canvas, p.x, p.y, { deltaY: 1000, shiftKey: true });
        });
        omitted += check(h, s0, f.s, f.l);
      }
      expect(omitted).toBeGreaterThan(0);
    });

    it('after the refetch', () => {
      const h = setup({ size: TINY });
      const s0 = last(h);
      const p = at(s0, 0.3);
      for (let i = 0; i < 4; i++) wheel(h.canvas, p.x, p.y, { deltaY: -300 });
      h.flush();
      h.advance(300);
      const c = present(h.commit[0]?.window, 'commit');
      h.frame.setTimeWindow(c);
      const r = step(h, () => {
        h.frame.setData(lineData(0, 2e22));
      });
      expect(check(h, s0, r.s, r.l)).toBe(1);
      expect(r.l.map((x) => x.text)).not.toContain('1.5e+22');
    });
  });
});
