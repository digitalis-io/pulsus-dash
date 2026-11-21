/** STUB (#93 tests first): the 2D camera math. */
import type { PlotRect, TimeWindow } from '../api';

export interface Span {
  readonly lo: number;
  readonly hi: number;
}
export interface SpanLimits {
  readonly minSpan: number;
  readonly maxSpan: number;
  readonly lo: number;
  readonly hi: number;
}

export function timeLimits(_plotWidth: number): SpanLimits {
  return { minSpan: 0, maxSpan: Infinity, lo: -Infinity, hi: Infinity };
}
export function valueLimits(_anchor: number): SpanLimits {
  return { minSpan: 0, maxSpan: Infinity, lo: -Infinity, hi: Infinity };
}
export function zoomAbout(s: Span, _f: number, _factor: number, _limits: SpanLimits): Span {
  return s;
}
export function panBy(s: Span, _fraction: number, _limits: SpanLimits, _step = 0): Span {
  return s;
}
export function contain(s: Span, _limits: SpanLimits): Span {
  return s;
}
export const fx = (plot: PlotRect, x: number): number => (x - plot.x) / plot.width;
export const fy = (plot: PlotRect, y: number): number => 1 - (y - plot.y) / plot.height;
export function toWindow(s: Span): TimeWindow {
  return { fromMs: s.lo, toMs: s.hi };
}
