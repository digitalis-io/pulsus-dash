/**
 * The bar fill shared by the bar chart and the time bars: the series (or state) colour as a
 * gradient along the value axis, full at the value end and `BASE_ALPHA` at the base, a 1 px
 * lighter highlight along the value edge, and the two corners at the value end rounded. Under
 * forced colours (`plain`) a bar is one flat fill of its colour, with no gradient or highlight. A
 * stacked segment passes its column's `ramp`, so the stack shades as one bar.
 */
import type { Ctx2D } from './ctx';
import { withAlpha } from './palette';

/** The fill alpha at the bar's base. */
export const BASE_ALPHA = 0.7;
/** How far the highlight mixes the bar colour toward white. */
const HIGHLIGHT_MIX = 0.35;
/** The highlight's alpha over the fill. */
const HIGHLIGHT_ALPHA = 0.6;

/** Which side of the bar is its value end. */
export type ValueEnd = 'top' | 'bottom' | 'left' | 'right';

export interface BarRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** `#RRGGBB` mixed toward white by `k` ∈ [0, 1]; the input unchanged when it is not `#RRGGBB…`. */
export function lighten(hex: string, k: number): string {
  if (!/^#[0-9a-fA-F]{6}/.test(hex)) return hex;
  const ch = (i: number): string => {
    const v = parseInt(hex.slice(i, i + 2), 16);
    return Math.round(v + (255 - v) * k)
      .toString(16)
      .padStart(2, '0');
  };
  return `${hex.slice(0, 1)}${ch(1)}${ch(3)}${ch(5)}`.toUpperCase();
}

/** The bar's outline with the two corners at `end` rounded by `r` (clamped to fit). */
export function barPath(ctx: Ctx2D, b: BarRect, end: ValueEnd, r: number): void {
  const { x, y, w, h } = b;
  const along = end === 'top' || end === 'bottom' ? h : w;
  const across = end === 'top' || end === 'bottom' ? w : h;
  const rr = Math.max(0, Math.min(r, across / 2, along));
  ctx.beginPath();
  if (rr === 0) {
    ctx.rect(x, y, w, h);
    return;
  }
  const x1 = x + w;
  const y1 = y + h;
  const H = Math.PI / 2;
  switch (end) {
    case 'top':
      ctx.moveTo(x, y1);
      ctx.lineTo(x, y + rr);
      ctx.arc(x + rr, y + rr, rr, 2 * H, 3 * H);
      ctx.lineTo(x1 - rr, y);
      ctx.arc(x1 - rr, y + rr, rr, 3 * H, 4 * H);
      ctx.lineTo(x1, y1);
      break;
    case 'bottom':
      ctx.moveTo(x, y);
      ctx.lineTo(x1, y);
      ctx.lineTo(x1, y1 - rr);
      ctx.arc(x1 - rr, y1 - rr, rr, 0, H);
      ctx.lineTo(x + rr, y1);
      ctx.arc(x + rr, y1 - rr, rr, H, 2 * H);
      break;
    case 'right':
      ctx.moveTo(x, y);
      ctx.lineTo(x1 - rr, y);
      ctx.arc(x1 - rr, y + rr, rr, 3 * H, 4 * H);
      ctx.lineTo(x1, y1 - rr);
      ctx.arc(x1 - rr, y1 - rr, rr, 0, H);
      ctx.lineTo(x, y1);
      break;
    case 'left':
      ctx.moveTo(x1, y1);
      ctx.lineTo(x + rr, y1);
      ctx.arc(x + rr, y1 - rr, rr, H, 2 * H);
      ctx.lineTo(x, y + rr);
      ctx.arc(x + rr, y + rr, rr, 2 * H, 3 * H);
      ctx.lineTo(x1, y);
      break;
  }
  ctx.closePath();
}

/** Fills one bar: gradient, value-end radius and (unless off) highlight; one flat fill when `plain`. */
export function fillBar(
  ctx: Ctx2D,
  b: BarRect,
  end: ValueEnd,
  colour: string,
  r: number,
  plain: boolean,
  highlight = true,
  ramp?: { readonly end: number; readonly base: number },
): void {
  if (!(b.w > 0) || !(b.h > 0)) return;
  barPath(ctx, b, end, r);
  if (plain) {
    ctx.fillStyle = colour;
    ctx.fill();
    return;
  }
  const vertical = end === 'top' || end === 'bottom';
  // The ramp runs from the value end to the base along the value axis: the bar's own, or `ramp`
  // (a stacked column's whole extent, so its segments shade as one bar).
  const r0 =
    ramp?.end ??
    (end === 'top' ? b.y : end === 'bottom' ? b.y + b.h : end === 'right' ? b.x + b.w : b.x);
  const r1 =
    ramp?.base ??
    (end === 'top' ? b.y + b.h : end === 'bottom' ? b.y : end === 'right' ? b.x : b.x + b.w);
  const g = vertical
    ? ctx.createLinearGradient(0, r0, 0, r1)
    : ctx.createLinearGradient(r0, 0, r1, 0);
  g.addColorStop(0, withAlpha(colour, 1));
  g.addColorStop(1, withAlpha(colour, BASE_ALPHA));
  ctx.fillStyle = g;
  ctx.fill();
  if (!highlight) return;
  // The 1 px highlight just inside the value edge, between the rounded corners.
  const across = end === 'top' || end === 'bottom' ? b.w : b.h;
  const inset = Math.min(r, across / 2);
  if (across - 2 * inset < 1) return;
  ctx.fillStyle = withAlpha(lighten(colour, HIGHLIGHT_MIX), HIGHLIGHT_ALPHA);
  switch (end) {
    case 'top':
      ctx.fillRect(b.x + inset, b.y, b.w - 2 * inset, 1);
      break;
    case 'bottom':
      ctx.fillRect(b.x + inset, b.y + b.h - 1, b.w - 2 * inset, 1);
      break;
    case 'right':
      ctx.fillRect(b.x + b.w - 1, b.y + inset, 1, b.h - 2 * inset);
      break;
    case 'left':
      ctx.fillRect(b.x, b.y + inset, 1, b.h - 2 * inset);
      break;
  }
}
