/**
 * `describe('camera')` of plan #93 §5.1 and Appendix A §A.12–A.13: wheel, pinch, swipe and drag
 * zoom and pan in the Canvas 2D frame, the commit event, the value-axis pin and the band hold.
 */
import { describe, expect, it, vi } from 'vitest';
import type { FrameData, FrameSummary, TimeWindow, ValueRange, VisSpec } from '../api';
import { formatCompact, formatValue, type Unit } from '../../i18n/format';
import { colour } from '../../styles/tokens';
import {
  gesture,
  harness,
  key,
  pointer,
  seriesData,
  seriesFrame,
  wheel,
  type Harness,
} from '../../test/engineHarness';
import { mulberry32 } from '../../test/random';
import { CHAR_WIDTH, recordingContext } from '../../test/recordingContext';
import { Canvas2DEngine } from './Canvas2DEngine';
import { brushSnapUnit } from './columns';
import { measureValueBand, minValueBand } from './draw';
import type { WheelLatch } from './input';
import { themeColours } from './palette';

const KEY = '00000000000000a1';
const T0 = Date.UTC(2026, 10, 19, 12);
const T1 = Date.UTC(2026, 10, 19, 13);
const W0: TimeWindow = { fromMs: T0, toMs: T1 };
const NONE: Unit = { kind: 'none' };
const LINE: VisSpec = { kind: 'line', title: 'T', unit: NONE };
const CHIP = colour.dark['surface-2'];
/** `space.2 + chart-tick`: the plot starts this far right of the value-label band. */
const GAP_X = 8 + 4;

/** 61 samples over 12:00–13:00, value `lo + (hi − lo) · i / 60`. */
function lineData(lo = 0, hi = 30, n = 61, from = T0, to = T1): FrameData {
  const ts = Array.from({ length: n }, (_, i) => from + ((to - from) * i) / (n - 1));
  return seriesData(
    seriesFrame(
      KEY,
      ts,
      ts.map((_, i) => lo + ((hi - lo) * i) / (n - 1)),
    ),
  );
}

interface Setup {
  spec?: VisSpec;
  data?: FrameData;
  w?: TimeWindow;
  size?: readonly [number, number];
  keyTarget?: HTMLElement | null;
  latch?: WheelLatch;
}

function setup(o: Setup = {}): Harness {
  const h = harness(Canvas2DEngine, {
    keyTarget: o.keyTarget ?? null,
    ...(o.latch === undefined ? {} : { latch: o.latch }),
  });
  h.frame.setSpec(o.spec ?? LINE);
  h.frame.setData(o.data ?? lineData());
  h.frame.setTimeWindow(o.w ?? W0);
  h.frame.resize(o.size?.[0] ?? 800, o.size?.[1] ?? 240, 1);
  h.flush();
  return h;
}

/** `v`, asserted present: a missing value fails on an assertion, not an error. */
function present<T>(v: T | null | undefined, what: string): T {
  expect(v, what).not.toBeUndefined();
  expect(v, what).not.toBeNull();
  return v as T;
}
/** A manual value range, asserted (not `'auto'`). */
function range(v: ValueRange | 'auto' | null | undefined): ValueRange {
  expect(v).not.toBe('auto');
  return present(v, 'value range') as ValueRange;
}

const last = (h: Harness): FrameSummary => present(h.a11y.at(-1), 'summary');
const xOf = (s: FrameSummary, t: number): number =>
  s.plot.x + ((t - s.fromMs) / (s.toMs - s.fromMs)) * s.plot.width;
const tAt = (s: FrameSummary, x: number): number =>
  s.fromMs + ((x - s.plot.x) / s.plot.width) * (s.toMs - s.fromMs);
const axisOf = (s: FrameSummary) => present(s.valueAxis, 'value axis');
const yOf = (s: FrameSummary, v: number): number => {
  const a = axisOf(s);
  return s.plot.y + (1 - (v - a.min) / (a.max - a.min)) * s.plot.height;
};
const vAt = (s: FrameSummary, y: number): number => {
  const a = axisOf(s);
  return a.min + (1 - (y - s.plot.y) / s.plot.height) * (a.max - a.min);
};
const winOf = (s: FrameSummary): TimeWindow => ({ fromMs: s.fromMs, toMs: s.toMs });

interface Label {
  readonly text: string;
  readonly left: number;
  readonly right: number;
  readonly y: number;
  readonly chip: boolean;
}

/** Value labels of the layer ops since the last `clearOps`: right-aligned, or chipped in the plot. */
function labels(h: Harness): Label[] {
  const ops = h.layer().ops;
  const out: Label[] = [];
  ops.forEach((o, k) => {
    if (o.op !== 'fillText' || (o.textAlign !== 'right' && o.textAlign !== 'left')) return;
    const text = String(o.args[0]);
    const x = Number(o.args[1]);
    const w = CHAR_WIDTH * text.length;
    const left = o.textAlign === 'right' ? x - w : x;
    const before = ops[k - 1];
    out.push({
      text,
      left,
      right: left + w,
      y: Number(o.args[2]),
      chip: before?.op === 'fill' && before.fillStyle === CHIP,
    });
  });
  return out;
}

/**
 * The tick value of each label, from its y: ticks are whole multiples of one 1-, 2- or 5-step, so
 * the value is snapped to the step the labels' spacing gives (12 significant digits, as drawn).
 */
function tickValues(s: FrameSummary, l: readonly Label[]): number[] {
  const raw = l.map((x) => vAt(s, x.y));
  const sorted = [...raw].sort((a, b) => a - b);
  let gap = Infinity;
  for (let k = 1; k < sorted.length; k++) {
    const d = (sorted[k] ?? 0) - (sorted[k - 1] ?? 0);
    if (d > 0 && d < gap) gap = d;
  }
  expect(gap, 'two distinct ticks').toBeLessThan(Infinity);
  const stepV = Number(gap.toPrecision(1));
  return raw.map((v) => Number((Math.round(v / stepV) * stepV).toPrecision(12)));
}

/** The label the hold draws for `t`: full when it fits `band`, else compact, else chipped whole. */
function heldText(t: number, unit: Unit, band: number): { text: string; chip: boolean } {
  const full = formatValue(t, unit);
  if (CHAR_WIDTH * full.length <= band) return { text: full, chip: false };
  const compact = formatCompact(t, unit);
  if (CHAR_WIDTH * compact.length <= band) return { text: compact, chip: false };
  return { text: full, chip: true };
}

/** Clears the layer ops, runs `act`, flushes; returns the summary and the drawn value labels. */
function step(h: Harness, act: () => void): { s: FrameSummary; l: Label[] } {
  h.layer().clearOps();
  act();
  h.flush();
  return { s: last(h), l: labels(h) };
}

/** The plot x the layer would use for these inputs without a held band. */
function measuredX(
  spec: VisSpec,
  data: FrameData,
  window: TimeWindow,
  valueRange: ValueRange | null,
  cssW = 800,
  cssH = 240,
): number {
  const band = measureValueBand({
    ctx: recordingContext(),
    spec,
    data,
    window,
    cssW,
    cssH,
    timeZone: 'Europe/London',
    colours: themeColours('dark'),
    valueRange,
    band: null,
  });
  return band + GAP_X;
}

/** Centre of the plot, and points at a fraction of its width and height from the top. */
const at = (s: FrameSummary, fxw: number, fyh = 0.5) => ({
  x: s.plot.x + fxw * s.plot.width,
  y: s.plot.y + fyh * s.plot.height,
});

describe('camera', () => {
  it('unit:camera-controller 100 random wheel steps', () => {
    const h = setup();
    const plot0 = last(h).plot;
    const rnd = mulberry32(93);
    let ta = 0;
    let va = 0;
    let p = { x: 0, y: 0 };
    for (let n = 0; n < 100; n++) {
      const prev = last(h);
      p = at(prev, rnd(), rnd());
      ta = tAt(prev, p.x);
      va = vAt(prev, p.y);
      const d = (rnd() * 2 - 1) * 300;
      const mode = Math.floor(rnd() * 4);
      const init =
        mode === 0
          ? { deltaY: d }
          : mode === 1
            ? { deltaY: d, shiftKey: true }
            : mode === 2
              ? { deltaY: Math.round(d), ctrlKey: true }
              : { deltaY: d + 0.25, ctrlKey: true };
      wheel(h.canvas, p.x, p.y, init);
      h.flush();
      const s = last(h);
      expect(s.plot.x).toBe(plot0.x);
      expect(s.plot.width).toBe(plot0.width);
      expect(Math.abs(xOf(s, ta) - p.x)).toBeLessThan(0.01);
      expect(Math.abs(yOf(s, va) - p.y)).toBeLessThan(0.01);
    }
    h.advance(300);
    h.flush();
    const s = last(h);
    expect(s.plot).toEqual(plot0);
    expect(Math.abs(xOf(s, ta) - p.x)).toBeLessThan(1);
    expect(Math.abs(yOf(s, va) - p.y)).toBeLessThan(1);
  });

  it('X and Y zoom independently', () => {
    const h = setup();
    const s0 = last(h);
    const p = at(s0, 0.4);
    wheel(h.canvas, p.x, p.y, { deltaY: -100 });
    h.flush();
    const s1 = last(h);
    expect(s1.fromMs).not.toBe(s0.fromMs);
    expect(s1.toMs).not.toBe(s0.toMs);
    expect(s1.valueAxis?.manual).toBe(false);
    wheel(h.canvas, p.x, p.y, { deltaY: -100, shiftKey: true });
    h.flush();
    const s2 = last(h);
    expect(winOf(s2)).toEqual(winOf(s1));
    expect(s2.valueAxis?.manual).toBe(true);
    expect(s2.valueAxis).not.toEqual(s1.valueAxis);
    wheel(h.canvas, p.x, p.y, { deltaY: -100 });
    h.flush();
    const s3 = last(h);
    expect(winOf(s3)).not.toEqual(winOf(s2));
    expect(s3.valueAxis).toEqual(s2.valueAxis);
  });

  it('wheel commits after 300 ms idle', () => {
    const h = setup();
    const p = at(last(h), 0.3);
    for (let i = 0; i < 3; i++) {
      if (i > 0) h.advance(100);
      wheel(h.canvas, p.x, p.y, { deltaY: -100 });
      h.flush();
    }
    h.advance(299);
    expect(h.commit).toEqual([]);
    h.advance(1);
    expect(h.commit).toHaveLength(1);
    const c = h.commit[0];
    expect(c?.value).toBeNull();
    expect(c?.gesture).toBe('wheel');
    const w = present(c?.window, 'window');
    expect(Number.isInteger(w.fromMs) && Number.isInteger(w.toMs)).toBe(true);
    h.flush();
    expect(winOf(last(h))).toEqual(w);
  });

  it('Ctrl+wheel commits both axes', () => {
    const h = setup();
    const p = at(last(h), 0.3);
    expect(wheel(h.canvas, p.x, p.y, { deltaY: -100, ctrlKey: true }).defaultPrevented).toBe(true);
    h.flush();
    h.advance(300);
    expect(h.commit).toHaveLength(1);
    expect(h.commit[0]?.window).not.toBeNull();
    expect(h.commit[0]?.value).not.toBeNull();
  });

  it('pinch zooms time only', () => {
    const h = setup();
    const s0 = last(h);
    const p = at(s0, 0.3);
    const ta = tAt(s0, p.x);
    for (let i = 0; i < 4; i++) wheel(h.canvas, p.x, p.y, { deltaY: -2.5, ctrlKey: true });
    h.flush();
    const s = last(h);
    expect(s.toMs - s.fromMs).toBeLessThan(s0.toMs - s0.fromMs);
    expect(Math.abs(xOf(s, ta) - p.x)).toBeLessThan(0.01);
    expect(s.valueAxis?.manual).toBe(false);
    h.advance(300);
    expect(h.commit).toHaveLength(1);
    expect(h.commit[0]?.value).toBeNull();
  });

  it('⌘+wheel zooms both', () => {
    const h = setup();
    const p = at(last(h), 0.3);
    wheel(h.canvas, p.x, p.y, { deltaY: -2.5, metaKey: true });
    h.flush();
    expect(last(h).valueAxis?.manual).toBe(true);
  });

  it('Safari gesture zooms time', () => {
    const h = setup();
    const s0 = last(h);
    const p = at(s0, 0.3);
    const ta = tAt(s0, p.x);
    const start = gesture(h.canvas, 'gesturestart', p.x, p.y, 1);
    const change = gesture(h.canvas, 'gesturechange', p.x, p.y, 2);
    h.flush();
    const s1 = last(h);
    expect(s1.toMs - s1.fromMs).toBeCloseTo((s0.toMs - s0.fromMs) / 2, 3);
    expect(Math.abs(xOf(s1, ta) - p.x)).toBeLessThan(0.01);
    wheel(h.canvas, p.x, p.y, { deltaY: -100, ctrlKey: true });
    h.flush();
    expect(last(h)).toEqual(s1);
    const end = gesture(h.canvas, 'gestureend', p.x, p.y, 2);
    expect([start, change, end].map((e) => e.defaultPrevented)).toEqual([true, true, true]);
    h.advance(300);
    expect(h.commit).toHaveLength(1);
    expect(h.commit[0]?.gesture).toBe('wheel');
  });

  it('swipe pans time', () => {
    const h = setup();
    const s0 = last(h);
    const p = at(s0, 0.3);
    wheel(h.canvas, p.x, p.y, { deltaX: 80, deltaY: 5 });
    h.flush();
    const s = last(h);
    const span = s0.toMs - s0.fromMs;
    expect(s.fromMs - s0.fromMs).toBeCloseTo((80 / s0.plot.width) * span, 3);
    expect(s.toMs - s.fromMs).toBeCloseTo(span, 3);
  });

  it('wheel outside the plot is not consumed', () => {
    const h = setup();
    const s0 = last(h);
    const mid = s0.plot.y + s0.plot.height / 2;
    for (const [x, y] of [
      [s0.plot.x - 10, mid],
      [s0.plot.x + 100, 239],
      [s0.plot.x + s0.plot.width + 4, mid],
    ] as const) {
      expect(wheel(h.canvas, x, y, { deltaY: -100 }).defaultPrevented).toBe(false);
    }
    h.flush();
    expect(last(h)).toEqual(s0);
    h.advance(400);
    expect(h.commit).toEqual([]);
  });

  it('scroll latch', () => {
    const t = 10_000;
    const h = setup({ latch: { lastPageWheel: () => t } });
    const s0 = last(h);
    const p = at(s0, 0.5);
    const first = wheel(h.canvas, p.x, p.y, { deltaY: -100, timeStamp: t + 100 });
    h.flush();
    expect(first.defaultPrevented).toBe(false);
    expect(last(h)).toEqual(s0);
    const second = wheel(h.canvas, p.x, p.y, { deltaY: -100, timeStamp: t + 400 });
    h.flush();
    expect(second.defaultPrevented).toBe(true);
    expect(last(h).toMs - last(h).fromMs).toBeLessThan(s0.toMs - s0.fromMs);
  });

  it('left drag pans and commits on release', () => {
    const h = setup();
    const s0 = last(h);
    const p = at(s0, 0.5);
    const span = s0.toMs - s0.fromMs;
    pointer(h.canvas, 'pointerdown', p.x, p.y, { buttons: 1 });
    expect(h.canvas.dataset['gesture']).toBe('pan');
    pointer(h.canvas, 'pointermove', p.x + 3, p.y, { buttons: 1 });
    h.flush();
    expect(winOf(last(h))).toEqual(winOf(s0));
    pointer(h.canvas, 'pointermove', p.x + 200, p.y, { buttons: 1 });
    h.flush();
    expect(Math.abs(last(h).fromMs - (s0.fromMs - (200 / s0.plot.width) * span))).toBeLessThan(1);
    pointer(h.canvas, 'pointerup', p.x + 200, p.y);
    expect(h.commit).toHaveLength(1);
    expect(h.commit[0]?.gesture).toBe('pan');
    expect(h.commit[0]?.value).toBeNull();
    expect(h.brush).toEqual([]);
    expect(h.canvas.dataset['gesture']).toBeUndefined();
  });

  it('middle drag pans', () => {
    const h = setup();
    const s0 = last(h);
    const p = at(s0, 0.5);
    const down = pointer(h.canvas, 'pointerdown', p.x, p.y, { button: 1, buttons: 4 });
    expect(down.defaultPrevented).toBe(true);
    pointer(h.canvas, 'pointermove', p.x + 200, p.y, { button: 1, buttons: 4 });
    h.flush();
    expect(last(h).fromMs).toBeLessThan(s0.fromMs);
    pointer(h.canvas, 'pointerup', p.x + 200, p.y, { button: 1 });
    expect(h.commit.map((c) => c.gesture)).toEqual(['pan']);
  });

  it('right drag and Alt+left drag box-zoom', () => {
    for (const how of ['right', 'alt'] as const) {
      const h = setup({ size: [1_100, 240] });
      const p0 = last(h).plot;
      h.frame.resize(1_100 + 1_000 - p0.width, 240, 1);
      h.flush();
      const plot = last(h).plot;
      expect(plot.width).toBe(1_000);
      const o = how === 'right' ? { button: 2, buttons: 2 } : { altKey: true, buttons: 1 };
      const x = (ms: number): number => plot.x + ((ms - T0) / (T1 - T0)) * plot.width;
      const y = plot.y + plot.height / 2;
      pointer(h.canvas, 'pointerdown', x(T0 + 20 * 60_000 + 1_200), y, o);
      expect(h.canvas.dataset['gesture']).toBe('box');
      pointer(h.canvas, 'pointermove', x(T0 + 22 * 60_000), y, o);
      pointer(h.canvas, 'pointerup', x(T0 + 24 * 60_000 + 58_900), y, o);
      h.flush();
      expect(brushSnapUnit(3_600)).toBe(15_000);
      expect(h.brush).toEqual([
        { fromMs: T0 + 20 * 60_000, toMs: T0 + 25 * 60_000, gesture: 'drag' },
      ]);
      expect(h.commit).toEqual([]);
      pointer(h.canvas, 'pointerdown', 500, y, o);
      pointer(h.canvas, 'pointermove', 503, y, o);
      pointer(h.canvas, 'pointerup', 503, y, o);
      h.advance(10);
      expect(h.brush).toHaveLength(1);
      expect(h.commit).toEqual([]);
    }
  });

  it('context menu rules', () => {
    const menu = (h: Harness): boolean => {
      const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      h.canvas.dispatchEvent(e);
      return e.defaultPrevented;
    };
    const R = { button: 2, buttons: 2 };
    const seen: boolean[] = [];
    // (1) contextmenu while the right button is down.
    let h = setup();
    let p = at(last(h), 0.5);
    pointer(h.canvas, 'pointerdown', p.x, p.y, R);
    seen.push(menu(h));
    const brush1 = h.brush.length;
    // (2) moved 50 px, released, then contextmenu.
    h = setup();
    p = at(last(h), 0.4);
    pointer(h.canvas, 'pointerdown', p.x, p.y, R);
    pointer(h.canvas, 'pointermove', p.x + 50, p.y, R);
    pointer(h.canvas, 'pointerup', p.x + 50, p.y, R);
    seen.push(menu(h));
    const brush2 = h.brush.length;
    // (3) no movement, released, then contextmenu.
    h = setup();
    p = at(last(h), 0.4);
    pointer(h.canvas, 'pointerdown', p.x, p.y, R);
    pointer(h.canvas, 'pointerup', p.x, p.y, R);
    seen.push(menu(h));
    const brush3 = h.brush.length;
    // (4) the keyboard menu key: no press.
    h = setup();
    seen.push(menu(h));
    // (5) a right press on the y-axis band.
    h = setup();
    const s = last(h);
    pointer(h.canvas, 'pointerdown', s.plot.x - 10, s.plot.y + 50, R);
    seen.push(menu(h));
    expect(seen).toEqual([true, true, true, false, false]);
    expect([brush1, brush2, brush3]).toEqual([0, 1, 0]);
  });

  it('macOS secondary click and touch ignored', () => {
    const h = setup();
    const s0 = last(h);
    const p = at(s0, 0.5);
    const ctrl = pointer(h.canvas, 'pointerdown', p.x, p.y, { ctrlKey: true, buttons: 1 });
    pointer(h.canvas, 'pointermove', p.x + 100, p.y, { ctrlKey: true, buttons: 1 });
    pointer(h.canvas, 'pointerup', p.x + 100, p.y, { ctrlKey: true });
    const touch = pointer(h.canvas, 'pointerdown', p.x, p.y, { pointerType: 'touch' });
    pointer(h.canvas, 'pointermove', p.x + 100, p.y, { pointerType: 'touch' });
    pointer(h.canvas, 'pointerup', p.x + 100, p.y, { pointerType: 'touch' });
    h.flush();
    expect([ctrl.defaultPrevented, touch.defaultPrevented]).toEqual([false, false]);
    expect(winOf(last(h))).toEqual(winOf(s0));
    expect(h.commit).toEqual([]);
    expect(h.brush).toEqual([]);
  });

  it('Escape and pointercancel cancel a press', () => {
    const target = document.createElement('div');
    const h = setup({ keyTarget: target });
    const s0 = last(h);
    const p = at(s0, 0.5);
    pointer(h.canvas, 'pointerdown', p.x, p.y, { buttons: 1 });
    pointer(h.canvas, 'pointermove', p.x + 150, p.y, { buttons: 1 });
    h.flush();
    expect(last(h).fromMs).not.toBe(s0.fromMs);
    const esc = key(target, 'Escape');
    expect(esc.defaultPrevented).toBe(true);
    h.flush();
    expect(winOf(last(h))).toEqual(winOf(s0));
    pointer(h.canvas, 'pointerup', p.x + 150, p.y);
    pointer(h.canvas, 'pointerdown', p.x, p.y, { button: 2, buttons: 2 });
    pointer(h.canvas, 'pointermove', p.x + 150, p.y, { button: 2, buttons: 2 });
    pointer(h.canvas, 'pointercancel', p.x + 150, p.y);
    pointer(h.canvas, 'pointerup', p.x + 150, p.y, { button: 2 });
    h.flush();
    expect(winOf(last(h))).toEqual(winOf(s0));
    expect(h.commit).toEqual([]);
    expect(h.brush).toEqual([]);
  });

  it('axis drags', () => {
    const h = setup();
    const s0 = last(h);
    const below = s0.plot.y + s0.plot.height + 10;
    const xa = s0.plot.x + 300;
    pointer(h.canvas, 'pointerdown', xa, below, { buttons: 1 });
    expect(h.canvas.dataset['gesture']).toBe('axis-x');
    pointer(h.canvas, 'pointermove', xa + 100, below, { buttons: 1 });
    pointer(h.canvas, 'pointerup', xa + 100, below);
    expect(h.commit).toHaveLength(1);
    expect(h.commit[0]?.gesture).toBe('axis');
    expect(h.commit[0]?.value).toBeNull();
    expect(h.commit[0]?.window?.fromMs).toBeLessThan(s0.fromMs);
    h.flush();
    const s1 = last(h);
    const d0 = axisOf(s1);
    const left = s1.plot.x - 10;
    const ya = s1.plot.y + 100;
    pointer(h.canvas, 'pointerdown', left, ya, { buttons: 1 });
    expect(h.canvas.dataset['gesture']).toBe('axis-y');
    pointer(h.canvas, 'pointermove', left, ya - 50, { buttons: 1 });
    pointer(h.canvas, 'pointerup', left, ya - 50);
    expect(h.commit).toHaveLength(2);
    const c = h.commit[1];
    expect(c?.window).toBeNull();
    expect(c?.gesture).toBe('axis');
    const v = range(c?.value);
    const width = d0.max - d0.min;
    expect(v.min).toBeCloseTo(d0.min - (50 / s1.plot.height) * width, 9);
    expect(v.max).toBeCloseTo(d0.max - (50 / s1.plot.height) * width, 9);
  });

  it('value-axis double-click fits', () => {
    const h = setup({ spec: { ...LINE, valueRange: { min: 10, max: 20 } } });
    const s = last(h);
    expect(s.valueAxis).toEqual({ min: 10, max: 20, manual: true });
    pointer(h.canvas, 'dblclick', s.plot.x - 10, s.plot.y + 50);
    expect(h.commit).toEqual([{ window: null, value: 'auto', gesture: 'fit' }]);
    pointer(h.canvas, 'dblclick', s.plot.x + 100, s.plot.y + 50);
    expect(h.brush.at(-1)?.gesture).toBe('zoomOut');
  });

  it('setTimeWindow during a time gesture keeps the preview', () => {
    const h = setup();
    const p = at(last(h), 0.3);
    wheel(h.canvas, p.x, p.y, { deltaY: -200 });
    h.flush();
    const preview = winOf(last(h));
    h.frame.setTimeWindow({ fromMs: T1, toMs: T1 + 3_600_000 });
    h.flush();
    expect(winOf(last(h))).toEqual(preview);
    h.advance(300);
    expect(h.commit).toHaveLength(1);
    expect(h.commit[0]?.window).toEqual({
      fromMs: Math.round(preview.fromMs),
      toMs: Math.round(preview.toMs),
    });
  });

  it('external time update during a Y zoom', () => {
    for (const how of ['wheel', 'drag'] as const) {
      const h = setup();
      const s0 = last(h);
      const p = at(s0, 0.3);
      const left = s0.plot.x - 10;
      if (how === 'wheel') {
        wheel(h.canvas, p.x, p.y, { deltaY: -100, shiftKey: true });
        wheel(h.canvas, p.x, p.y, { deltaY: -100, shiftKey: true });
      } else {
        pointer(h.canvas, 'pointerdown', left, p.y, { buttons: 1 });
        pointer(h.canvas, 'pointermove', left, p.y - 30, { buttons: 1 });
      }
      h.frame.setTimeWindow({ fromMs: T1, toMs: T1 + 3_600_000 });
      h.flush();
      expect(winOf(last(h))).toEqual({ fromMs: T1, toMs: T1 + 3_600_000 });
      expect(last(h).valueAxis?.manual).toBe(true);
      if (how === 'wheel') {
        wheel(h.canvas, p.x, p.y, { deltaY: -100, shiftKey: true });
        h.advance(300);
      } else {
        pointer(h.canvas, 'pointermove', left, p.y - 40, { buttons: 1 });
        pointer(h.canvas, 'pointerup', left, p.y - 40);
      }
      h.flush();
      expect(h.commit).toHaveLength(1);
      expect(h.commit[0]).toMatchObject({
        window: null,
        gesture: how === 'wheel' ? 'wheel' : 'axis',
      });
      expect(h.commit[0]?.value).toMatchObject({ min: expect.any(Number) as number });
      expect(winOf(last(h))).toEqual({ fromMs: T1, toMs: T1 + 3_600_000 });
    }
  });

  it('Y-only gestures never commit time', () => {
    const h = setup();
    const s0 = last(h);
    const p = at(s0, 0.3);
    for (let i = 0; i < 5; i++) wheel(h.canvas, p.x, p.y, { deltaY: -100, shiftKey: true });
    h.advance(300);
    h.flush();
    const left = s0.plot.x - 10;
    pointer(h.canvas, 'pointerdown', left, p.y, { buttons: 1 });
    pointer(h.canvas, 'pointermove', left, p.y - 50, { buttons: 1 });
    pointer(h.canvas, 'pointerup', left, p.y - 50);
    expect(h.commit).toHaveLength(2);
    expect(h.commit.every((c) => c.window === null)).toBe(true);
  });

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

  it('wide chart commit at the minimum span', () => {
    const h0 = setup({ size: [4_000, 240] });
    const W = last(h0).plot.width;
    expect(W % 2).toBe(0);
    const T = T0;
    const h = setup({ size: [4_000, 240], w: { fromMs: T, toMs: T + 3 * W + 1 } });
    const s0 = last(h);
    const p = { x: s0.plot.x + W / 2, y: s0.plot.y + s0.plot.height / 2 };
    const ta = tAt(s0, p.x);
    for (let i = 0; i < 3; i++) wheel(h.canvas, p.x, p.y, { deltaY: -400 });
    h.flush();
    expect(last(h).fromMs).toBeCloseTo(T + W + 0.5, 6);
    h.advance(300);
    h.flush();
    expect(h.commit[0]?.window).toEqual({ fromMs: T + W + 1, toMs: T + 2 * W + 1 });
    expect(Math.abs(xOf(last(h), ta) - p.x)).toBeCloseTo(0.5, 6);
  });

  it('sub-minimum window: swipe, zoom-in, commit', () => {
    const T = T0;
    const h = setup({ size: [4_000, 240], w: { fromMs: T, toMs: T + 2_000 } });
    const s0 = last(h);
    expect(2_000).toBeLessThan(Math.ceil(s0.plot.width));
    const p = { x: s0.plot.x + 0.3 * s0.plot.width, y: s0.plot.y + s0.plot.height / 2 };
    wheel(h.canvas, p.x, p.y, { deltaX: 37 });
    h.flush();
    const v1 = winOf(last(h));
    const ta = tAt(last(h), p.x);
    expect(v1.fromMs - T).toBe(Math.round((37 / s0.plot.width) * 2_000));
    expect(Number.isInteger(v1.fromMs) && Number.isInteger(v1.toMs)).toBe(true);
    expect(v1.toMs - v1.fromMs).toBe(2_000);
    for (let i = 0; i < 2; i++) {
      wheel(h.canvas, p.x, p.y, { deltaY: -400 });
      h.flush();
      expect(winOf(last(h))).toEqual(v1);
    }
    h.advance(300);
    h.flush();
    expect(h.commit).toHaveLength(1);
    expect(h.commit[0]?.window).toEqual(v1);
    expect(Math.abs(xOf(last(h), ta) - p.x)).toBeLessThan(1e-6);
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

  it('heatmap: no value zoom', () => {
    const spec: VisSpec = { kind: 'heatmap', title: 'T', unit: NONE, countUnit: NONE };
    const data: FrameData = {
      kind: 'heatmap',
      heatmap: {
        timestamps: new Float64Array([T0, T0 + 1_800_000]),
        bounds: new Float64Array([5, 10, Infinity]),
        counts: new Float64Array([0, 5, 10, 10, 0, 1]),
      },
    };
    const h = setup({ spec, data });
    const s0 = last(h);
    expect(s0.valueAxis).toBeNull();
    const p = at(s0, 0.5);
    expect(wheel(h.canvas, p.x, p.y, { deltaY: -100, shiftKey: true }).defaultPrevented).toBe(true);
    h.flush();
    expect(last(h)).toEqual(s0);
    pointer(h.canvas, 'pointerdown', s0.plot.x - 10, p.y, { buttons: 1 });
    pointer(h.canvas, 'pointermove', s0.plot.x - 10, p.y - 50, { buttons: 1 });
    pointer(h.canvas, 'pointerup', s0.plot.x - 10, p.y - 50);
    h.advance(300);
    h.flush();
    expect(last(h)).toEqual(s0);
    expect(h.commit).toEqual([]);
  });

  it('zones in the dataset', () => {
    const h = setup();
    const s = last(h);
    const seen: (string | undefined)[] = [];
    for (const [x, y] of [
      [s.plot.x + 50, s.plot.y + 50],
      [s.plot.x + 50, s.plot.y + s.plot.height + 10],
      [s.plot.x - 10, s.plot.y + 50],
      [s.plot.x + s.plot.width + 4, s.plot.y + 50],
    ] as const) {
      pointer(h.canvas, 'pointermove', x, y);
      seen.push(h.canvas.dataset['zone']);
    }
    expect(seen).toEqual(['plot', 'x-axis', 'y-axis', undefined]);
  });

  it('dispose during a wheel gesture', () => {
    const h = setup();
    const off = vi.spyOn(h.canvas, 'removeEventListener');
    const p = at(last(h), 0.5);
    wheel(h.canvas, p.x, p.y, { deltaY: -100 });
    h.frame.dispose();
    h.advance(400);
    expect(h.commit).toEqual([]);
    expect(off).toHaveBeenCalledTimes(12);
  });

  // Appendix A §A.13 (review r5 required fixes).

  it('sub-minimum preview survives a wider external window', () => {
    const T = T0;
    const h = setup({ size: [4_000, 240], w: { fromMs: T, toMs: T + 2_000 } });
    const s0 = last(h);
    expect(2_000).toBeLessThan(Math.ceil(s0.plot.width));
    const p = { x: s0.plot.x + 0.3 * s0.plot.width, y: s0.plot.y + s0.plot.height / 2 };
    wheel(h.canvas, p.x, p.y, { deltaX: 37 });
    h.flush();
    const v1 = winOf(last(h));
    expect(Number.isInteger(v1.fromMs) && Number.isInteger(v1.toMs)).toBe(true);
    expect(v1.toMs - v1.fromMs).toBe(2_000);
    h.frame.setTimeWindow({ fromMs: T, toMs: T + 3_600_000 });
    h.flush();
    expect(Number.isInteger((13 / s0.plot.width) * 2_000)).toBe(false);
    wheel(h.canvas, p.x, p.y, { deltaX: 13 });
    h.flush();
    const v2 = winOf(last(h));
    const ta = tAt(last(h), p.x);
    expect(Number.isInteger(v2.fromMs) && Number.isInteger(v2.toMs)).toBe(true);
    expect(v2.toMs - v2.fromMs).toBe(2_000);
    for (let i = 0; i < 2; i++) {
      wheel(h.canvas, p.x, p.y, { deltaY: -400 });
      h.flush();
      expect(winOf(last(h))).toEqual(v2);
    }
    h.advance(300);
    h.flush();
    expect(h.commit).toHaveLength(1);
    expect(h.commit[0]?.window).toEqual(v2);
    expect(Math.abs(xOf(last(h), ta) - p.x)).toBeLessThan(1e-6);
    h.frame.setTimeWindow(v2);
    h.flush();
    expect(winOf(last(h))).toEqual(v2);
  });

  it('non-fitting label during a Y zoom keeps the anchor', () => {
    // Deviation: zoom out to |v| ≥ 1e21 (valueLimits keeps a zoom-in span ≥ 1e-9, so no tick
    // below 1e-12 is reachable); the labels there have no compact form that fits either.
    const h = setup();
    const s0 = last(h);
    const plot0 = s0.plot;
    const band = plot0.x - GAP_X;
    const p = at(s0, 0.3);
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
        const want = heldText(ticks[k] ?? NaN, NONE, band);
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
    expect(r.l.map((x) => x.text)).toEqual(ticks.map((t) => formatValue(t, NONE)));
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
});
