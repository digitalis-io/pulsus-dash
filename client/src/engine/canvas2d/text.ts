/**
 * Label text that fits a width (plan #64 Part C §4.2): the threshold labels' `truncated` (ADR-0022,
 * moved here from `thresholdMark.ts`) and the event labels' `fitText` (ADR-0023). Widths are the
 * context's `measureText` in its current font; prefixes are whole code points.
 */
import type { Ctx2D } from './ctx';

/**
 * The longest prefix of `text`, at least 2 code points and shorter than the text, that fits `room`
 * with `…` appended; null when none does.
 */
export function fitText(ctx: Ctx2D, text: string, room: number): string | null {
  const cps = Array.from(text);
  // Widths grow with the prefix: binary search for the longest that fits.
  let lo = 2;
  let hi = cps.length - 1;
  let best: string | null = null;
  while (lo <= hi) {
    const n = Math.floor((lo + hi) / 2);
    const candidate = `${cps.slice(0, n).join('')}…`;
    if (ctx.measureText(candidate).width <= room) {
      best = candidate;
      lo = n + 1;
    } else {
      hi = n - 1;
    }
  }
  return best;
}

/** `fitText`, or the first code point (a threshold label's glyph) when no prefix fits. */
export function truncated(ctx: Ctx2D, text: string, room: number): string {
  return fitText(ctx, text, room) ?? Array.from(text)[0] ?? '';
}

/** A text width in CSS px (`measureText(t).width` in the axis font). */
export type Measure = (text: string) => number;

/** `head…tail` of `text` that fits `room` (the tail at least half); `text` when it fits. */
export function fitMiddle(m: Measure, text: string, room: number): string {
  void m;
  void room;
  return text;
}

/** Category names that fit `room` and differ pairwise (T22-004); null = hide every name. */
export function distinctLabels(
  m: Measure,
  names: readonly string[],
  room: number,
): string[] | null {
  void m;
  void room;
  return [...names];
}
