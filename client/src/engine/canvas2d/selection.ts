/**
 * The shared selection in the layer pass (ADR-0025, T02-025, T25-006, plan #192 §4.3). A frame dims
 * only when one of the selection's keys is among its own keys (relevance); an interval draws a
 * `selection` band whatever the keys. With no selection, or empty keys and no interval, the layer
 * makes exactly the calls it made before the selection existed.
 */
import type { FrameSelection, PlotRect, TimeWindow } from '../api';
import type { Ctx2D } from './ctx';
import type { ThemeColours } from './palette';

/** The selection's keys that are among `own`, or null when none is: the frame then dims nothing. */
export function matchedKeys(
  sel: FrameSelection | null | undefined,
  own: readonly string[],
): ReadonlySet<string> | null {
  if (sel === null || sel === undefined || sel.keys.length === 0) return null;
  const mine = new Set(own);
  const hit = new Set(sel.keys.filter((k) => mine.has(k)));
  return hit.size > 0 ? hit : null;
}

/**
 * The interval band over the plot: [x(fromMs), max(x(toMs) − x(fromMs), 1 device px)], clipped to
 * the plot; nothing without an interval or wholly outside the plot.
 */
export function drawSelectionBand(
  ctx: Ctx2D,
  colours: ThemeColours,
  plot: PlotRect,
  w: TimeWindow,
  sel: FrameSelection | null | undefined,
  dpr: number,
): void {
  if (sel === null || sel === undefined || sel.fromMs === null) return;
  const span = w.toMs - w.fromMs;
  if (!(span > 0)) return;
  const x = (t: number): number => plot.x + ((t - w.fromMs) / span) * plot.width;
  const x0 = x(sel.fromMs);
  const x1 = x(sel.toMs ?? sel.fromMs);
  const min = 1 / (dpr > 0 ? dpr : 1);
  const right0 = x0 + Math.max(x1 - x0, min);
  if (!(right0 >= plot.x) || !(x0 <= plot.x + plot.width)) return;
  const left = Math.max(x0, plot.x);
  const right = Math.min(right0, plot.x + plot.width);
  ctx.fillStyle = colours.selection;
  ctx.fillRect(left, plot.y, Math.max(right - left, min), plot.height);
}

/** The 2 px `focus` ring inside a rectangle (a selected bar segment, a selected stat tile). */
export function drawFocusRing(
  ctx: Ctx2D,
  colours: ThemeColours,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  if (!(w > 2) || !(h > 2)) return;
  ctx.strokeStyle = colours.focus;
  ctx.lineWidth = 2;
  ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
}
