/**
 * The live-edge rule for every time-window move made through a chart or the window keys: a move
 * that pushes the window's end later and past "now" is shifted back so the end is "now". The width
 * is kept, so the extra width goes into the past. A move that does not push the end later (zoom
 * in, step back) is left as it is.
 */
import { printTimeExpr, UNIT_MS, type TimeUnit } from './timeExpr';

export interface MsWindow {
  readonly fromMs: number;
  readonly toMs: number;
}

/**
 * `next` with its end at `nowMs` when it ends past `nowMs` and later than `prevToMs`; otherwise
 * `next` itself (`===`).
 */
export function clampToNow(next: MsWindow, prevToMs: number, nowMs: number): MsWindow {
  if (!(next.toMs > nowMs) || !(next.toMs > prevToMs)) return next;
  const shift = next.toMs - nowMs;
  return { fromMs: next.fromMs - shift, toMs: nowMs };
}

const UNITS_DESC: readonly TimeUnit[] = ['w', 'd', 'h', 'm', 's'];
const MAX_N = 99_999;

/** `now-<n><unit>` for a width of `ms`, or `null` when no whole unit expresses it. */
export function agoExpr(ms: number): string | null {
  if (!Number.isInteger(ms) || ms <= 0) return null;
  for (const unit of UNITS_DESC) {
    const u = UNIT_MS[unit];
    if (ms % u === 0 && ms / u <= MAX_N) return printTimeExpr({ kind: 'ago', n: ms / u, unit });
  }
  return null;
}
