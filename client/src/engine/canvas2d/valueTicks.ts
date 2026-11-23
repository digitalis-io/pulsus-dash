/** Nice value-axis ticks (plan #58 §4.1, VIZ-013): steps of 1, 2 or 5 × 10^k in units of base^p. */
export interface ValueTicks {
  readonly min: number;
  readonly max: number;
  readonly ticks: readonly number[];
}

/** The most step-search iterations before giving up (= dash-scales `MAX_STEPS`). */
export const MAX_TICK_STEPS = 64;
/** The largest end magnitude the nice search accepts (= dash-scales). */
export const NICE_MAX_ABS = 1e300;
/** The most tick intervals the nice search emits (= dash-scales). */
export const MAX_TICK_COUNT = 1e4;
/** Relative slack on the label gap: absorbs the rounding of y0 − y1 only (#97 plan §4.3). */
export const GAP_TOLERANCE = 1e-9;

const notImplemented = (...args: unknown[]): never => {
  throw new Error(`#97: not implemented (${String(args.length)} args)`);
};

/** The end shown when one label fits: the smaller |v|; on a tie, lo. */
export function nearerZero(lo: number, hi: number): number {
  return notImplemented(lo, hi);
}

/** Where v sits on [min, max] as a fraction from min (draw.ts's y mapping). */
export function valueFraction(v: number, min: number, max: number): number {
  return notImplemented(v, min, max);
}

/** The renderer's y of v (draw.ts `valueAxis`). */
export function tickY(v: number, min: number, max: number, top: number, height: number): number {
  return notImplemented(v, min, max, top, height);
}

/** True when every adjacent pair of ticks is at least one label gap apart on the drawn y. */
export function ticksFit(
  ticks: readonly number[],
  min: number,
  max: number,
  heightPx: number,
  labelHeightPx: number,
): boolean {
  return notImplemented(ticks, min, max, heightPx, labelHeightPx);
}

/** The bounded nice-step search; null when it gives up. */
export function niceValueTicks(
  dataMin: number,
  dataMax: number,
  heightPx: number,
  labelHeightPx: number,
  base: 1000 | 1024,
): ValueTicks | null {
  return notImplemented(dataMin, dataMax, heightPx, labelHeightPx, base);
}

/** The height-aware fallback ticks. */
export function extremeTicks(
  lo: number,
  hi: number,
  heightPx: number,
  labelHeightPx: number,
): ValueTicks {
  return notImplemented(lo, hi, heightPx, labelHeightPx);
}

/** The next nice step: 1 → 2 → 5 → 10. */
function nextNice(step: number): number {
  const k = Math.floor(Math.log10(step) + 1e-9);
  const m = Math.round(step / 10 ** k);
  return (m === 1 ? 2 : m === 2 ? 5 : 10) * 10 ** k;
}

/** The smallest of {1, 2, 5} · 10^k at least `x`. */
function niceAtLeast(x: number): number {
  const k = Math.floor(Math.log10(x));
  for (const m of [1, 2, 5, 10]) {
    const s = m * 10 ** k;
    if (s >= x * (1 - 1e-12)) return s;
  }
  return 10 ** (k + 1);
}

function round12(x: number): number {
  return Number(x.toPrecision(12));
}

function snapped(lo: number, hi: number, step: number): { min: number; max: number } {
  let min = Math.floor(lo / step) * step;
  let max = Math.ceil(hi / step) * step;
  if (min > lo) min -= step;
  if (max < hi) max += step;
  return { min, max };
}

export function valueTicks(
  dataMin: number,
  dataMax: number,
  heightPx: number,
  labelHeightPx: number,
  base: 1000 | 1024,
): ValueTicks {
  const lo = dataMin;
  const hi = dataMax === dataMin ? dataMin + 1 : dataMax;
  const p = Math.max(
    0,
    Math.floor(Math.log(Math.max(Math.abs(lo), Math.abs(hi))) / Math.log(base)),
  );
  const unit = base ** p;
  const target = (hi - lo) / unit / Math.max(2, Math.floor(heightPx / (2.5 * labelHeightPx)));
  let stepUnits = niceAtLeast(target);
  let { min, max } = snapped(lo, hi, stepUnits * unit);
  for (;;) {
    const step = stepUnits * unit;
    const count = Math.round((max - min) / step);
    const spacing = heightPx / count;
    if (spacing >= labelHeightPx + 2 || count <= 1) break;
    stepUnits = nextNice(stepUnits);
    ({ min, max } = snapped(lo, hi, stepUnits * unit));
  }
  const step = stepUnits * unit;
  const count = Math.round((max - min) / step);
  const ticks: number[] = [];
  for (let i = 0; i <= count; i++) ticks.push(round12(min + i * step));
  return { min, max, ticks };
}
