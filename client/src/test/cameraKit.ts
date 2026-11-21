/**
 * Shared setup of the camera tests (#93): a Canvas 2D frame on a line of 61 samples over
 * 12:00–13:00, summary geometry, and the value labels of the last layer draw.
 */
import { expect } from 'vitest';
import type { FrameData, FrameSummary, TimeWindow, ValueRange, VisSpec } from '../engine/api';
import { Canvas2DEngine } from '../engine/canvas2d/Canvas2DEngine';
import { measureValueBand } from '../engine/canvas2d/draw';
import type { WheelLatch } from '../engine/canvas2d/input';
import { themeColours } from '../engine/canvas2d/palette';
import { formatCompact, formatValue, type Unit } from '../i18n/format';
import { colour } from '../styles/tokens';
import { harness, seriesData, seriesFrame, type Harness } from './engineHarness';
import { CHAR_WIDTH, recordingContext } from './recordingContext';

export const KEY = '00000000000000a1';
export const T0 = Date.UTC(2026, 10, 19, 12);
export const T1 = Date.UTC(2026, 10, 19, 13);
export const W0: TimeWindow = { fromMs: T0, toMs: T1 };
export const NONE: Unit = { kind: 'none' };
export const LINE: Extract<VisSpec, { kind: 'line' }> = { kind: 'line', title: 'T', unit: NONE };
export const CHIP = colour.dark['surface-2'];
/** `space.2 + chart-tick`: the plot starts this far right of the value-label band. */
export const GAP_X = 8 + 4;

/** 61 samples over 12:00–13:00, value `lo + (hi − lo) · i / 60`. */
export function lineData(lo = 0, hi = 30, n = 61, from = T0, to = T1): FrameData {
  const ts = Array.from({ length: n }, (_, i) => from + ((to - from) * i) / (n - 1));
  return seriesData(
    seriesFrame(
      KEY,
      ts,
      ts.map((_, i) => lo + ((hi - lo) * i) / (n - 1)),
    ),
  );
}

export interface Setup {
  spec?: VisSpec;
  data?: FrameData;
  w?: TimeWindow;
  size?: readonly [number, number];
  keyTarget?: HTMLElement | null;
  latch?: WheelLatch;
}

export function setup(o: Setup = {}): Harness {
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
export function present<T>(v: T | null | undefined, what: string): T {
  expect(v, what).not.toBeUndefined();
  expect(v, what).not.toBeNull();
  return v as T;
}
/** A manual value range, asserted (not `'auto'`). */
export function range(v: ValueRange | 'auto' | null | undefined): ValueRange {
  expect(v).not.toBe('auto');
  return present(v, 'value range') as ValueRange;
}

export const last = (h: Harness): FrameSummary => present(h.a11y.at(-1), 'summary');
export const xOf = (s: FrameSummary, t: number): number =>
  s.plot.x + ((t - s.fromMs) / (s.toMs - s.fromMs)) * s.plot.width;
export const tAt = (s: FrameSummary, x: number): number =>
  s.fromMs + ((x - s.plot.x) / s.plot.width) * (s.toMs - s.fromMs);
export const axisOf = (s: FrameSummary) => present(s.valueAxis, 'value axis');
export const yOf = (s: FrameSummary, v: number): number => {
  const a = axisOf(s);
  return s.plot.y + (1 - (v - a.min) / (a.max - a.min)) * s.plot.height;
};
export const vAt = (s: FrameSummary, y: number): number => {
  const a = axisOf(s);
  return a.min + (1 - (y - s.plot.y) / s.plot.height) * (a.max - a.min);
};
export const winOf = (s: FrameSummary): TimeWindow => ({ fromMs: s.fromMs, toMs: s.toMs });

export interface Label {
  readonly text: string;
  readonly left: number;
  readonly right: number;
  readonly y: number;
  readonly chip: boolean;
}

/** Value labels of the layer ops since the last `clearOps`: right-aligned, or chipped in the plot. */
export function labels(h: Harness): Label[] {
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
export function tickValues(s: FrameSummary, l: readonly Label[]): number[] {
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
export function heldText(
  t: number,
  unit: Unit,
  band: number,
  plotWidth = Infinity,
): { text: string; chip: boolean } {
  const full = formatValue(t, unit);
  if (CHAR_WIDTH * full.length <= band) return { text: full, chip: false };
  const compact = formatCompact(t, unit);
  if (CHAR_WIDTH * compact.length <= band) return { text: compact, chip: false };
  // A chip holds the label and 4 px of padding a side inside the plot: the full form when it fits,
  // else the compact one, else the narrower of the two.
  const room = plotWidth - 2 * CHIP_PAD;
  if (CHAR_WIDTH * full.length <= room) return { text: full, chip: true };
  if (CHAR_WIDTH * compact.length <= room) return { text: compact, chip: true };
  return { text: compact.length < full.length ? compact : full, chip: true };
}

/** The chip's padding a side (`space.1`). */
export const CHIP_PAD = 4;

/** Clears the layer ops, runs `act`, flushes; returns the summary and the drawn value labels. */
export function step(h: Harness, act: () => void): { s: FrameSummary; l: Label[] } {
  h.layer().clearOps();
  act();
  h.flush();
  return { s: last(h), l: labels(h) };
}

/** The plot x the layer would use for these inputs without a held band. */
export function measuredX(
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
export const at = (s: FrameSummary, fxw: number, fyh = 0.5) => ({
  x: s.plot.x + fxw * s.plot.width,
  y: s.plot.y + fyh * s.plot.height,
});
