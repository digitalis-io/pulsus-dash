/**
 * Value-axis ticks (plan #58 §4.1, VIZ-013, T02-011, #97): a bounded nice-step search (steps of 1,
 * 2 or 5 × 10^k in units of base^p) and, when it gives up, a height-aware fallback. Both thin to
 * three, two or one ticks on short plots so labels never collide, and every result is checked
 * through the renderer's own y mapping (`tickY`). The engine's `dash_scales::value_ticks` and
 * `extreme_ticks` are the same algorithm, equal on the fixture inputs (`ticks.json`,
 * `ticks-extreme.json`) in every browser engine (#126): the integer powers come from `pow10` and
 * `powBase`, which return V8's `**` values (`pow.json`, as dash-scales `js_pow` does) through a
 * correctly rounded decimal parse and exact multiplication, never the engine's own `**`.
 */
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

/** The end shown when one label fits: the smaller |v|; on a tie, lo. */
export function nearerZero(lo: number, hi: number): number {
  return Math.abs(hi) < Math.abs(lo) ? hi : lo;
}

/**
 * Where v sits on [min, max] as a fraction from min: the y mapping of draw.ts. Uses the halved form
 * when max − min overflows; subnormal spans are exact (subtraction is exact there).
 */
export function valueFraction(v: number, min: number, max: number): number {
  const span = max - min;
  return Number.isFinite(span) ? (v - min) / span : (v / 2 - min / 2) / (max / 2 - min / 2);
}

/** The renderer's y of v (draw.ts `valueAxis`): top + (1 − valueFraction(v, min, max))·height. */
export function tickY(v: number, min: number, max: number, top: number, height: number): number {
  return top + (1 - valueFraction(v, min, max)) * height;
}

/**
 * True when every adjacent pair has finite y (top 0) and y[k−1] − y[k] ≥ (label + 2)·(1 −
 * GAP_TOLERANCE). Equal adjacent ticks give a 0 gap, so they fail. A single tick fits.
 */
export function ticksFit(
  ticks: readonly number[],
  min: number,
  max: number,
  heightPx: number,
  labelHeightPx: number,
): boolean {
  const gap = (labelHeightPx + 2) * (1 - GAP_TOLERANCE);
  for (let k = 1; k < ticks.length; k++) {
    const y0 = tickY(ticks[k - 1] ?? NaN, min, max, 0, heightPx);
    const y1 = tickY(ticks[k] ?? NaN, min, max, 0, heightPx);
    const d = y0 - y1;
    if (!(Number.isFinite(y0) && Number.isFinite(y1) && Number.isFinite(d) && d >= gap)) {
      return false;
    }
  }
  return true;
}

/**
 * The entries where V8's `10 ** k` (Node 24.22.3, engine/fixtures/pow.json) differs from the
 * correctly rounded `Number(`1e${k}`)`. `unit:js-pow` checks the whole table against pow.json.
 */
const V8_POW10_OVERRIDES: ReadonlyMap<number, number> = new Map([
  [23, 1.0000000000000001e23],
  [210, 1.0000000000000001e210],
]);
/** Likewise for `1000 ** p` (keyed by p). */
const V8_POW1000_OVERRIDES: ReadonlyMap<number, number> = new Map([[70, 1.0000000000000001e210]]);
/** 1024 ** p for p = 0..=102, by repeated exact multiplication (powers of two). */
const POW1024: readonly number[] = (() => {
  const t = [1];
  for (let p = 1; p <= 102; p++) t.push((t[p - 1] ?? NaN) * 1024);
  return t;
})();
/** 2^1022: the half-span limit of the nice search (a literal: no `**`). */
export const SPAN_HALF_LIMIT = 4.49423283715579e307;

/**
 * `10 ** k` as V8 computes it, for an integral or infinite k (= dash-scales `js_pow::pow10`):
 * NaN → NaN; k < −340 → 0; k > 308 → +∞; else override ?? Number(`1e${k}`). A decimal parse is
 * correctly rounded in every engine, so no engine's own `pow` is involved.
 */
export function pow10(k: number): number {
  if (Number.isNaN(k)) return NaN;
  if (k < -340) return 0;
  if (k > 308) return Infinity;
  return V8_POW10_OVERRIDES.get(k) ?? Number(`1e${String(k)}`);
}

/**
 * `base ** p` as V8 computes it, for base 1000 or 1024 and an integral p ≥ 0
 * (= dash-scales `js_pow::pow_base`): NaN or p < 0 → NaN; p > 102 → +∞;
 * 1000: override ?? Number(`1e${3 * p}`); 1024: POW1024[p].
 */
export function powBase(base: 1000 | 1024, p: number): number {
  if (Number.isNaN(p) || p < 0) return NaN;
  if (p > 102) return Infinity;
  if (base === 1024) return POW1024[p] ?? NaN;
  return V8_POW1000_OVERRIDES.get(p) ?? Number(`1e${String(3 * p)}`);
}

/** The next nice step: 1 → 2 → 5 → 10. */
function nextNice(step: number): number {
  const k = Math.floor(Math.log10(step) + 1e-9);
  const m = Math.round(step / pow10(k));
  return (m === 1 ? 2 : m === 2 ? 5 : 10) * pow10(k);
}

/** The smallest of {1, 2, 5} · 10^k at least `x`. */
function niceAtLeast(x: number): number {
  const k = Math.floor(Math.log10(x));
  for (const m of [1, 2, 5, 10]) {
    const s = m * pow10(k);
    if (s >= x * (1 - 1e-12)) return s;
  }
  return pow10(k + 1);
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

/**
 * The nice-step search, or null when it gives up: non-finite input, `dataMin > dataMax`, an end
 * beyond ±1e300, a span of 2^1023 or more, equal ends where `min + 1 === min`, no fitting step in
 * 64 iterations, a count outside [0, 1e4], a non-finite result, or ticks whose drawn gaps collide.
 * A two-tick result on a plot shorter than one label gap keeps the end nearer zero.
 */
export function niceValueTicks(
  dataMin: number,
  dataMax: number,
  heightPx: number,
  labelHeightPx: number,
  base: 1000 | 1024,
): ValueTicks | null {
  if (!(Number.isFinite(dataMin) && Number.isFinite(dataMax) && Number.isFinite(heightPx))) {
    return null;
  }
  if (dataMin > dataMax || Math.max(Math.abs(dataMin), Math.abs(dataMax)) > NICE_MAX_ABS) {
    return null;
  }
  if (dataMax / 2 - dataMin / 2 >= SPAN_HALF_LIMIT) return null;
  const lo = dataMin;
  const hi = dataMax === dataMin ? dataMin + 1 : dataMax;
  if (hi <= lo) return null;
  const p = Math.max(
    0,
    Math.floor(Math.log(Math.max(Math.abs(lo), Math.abs(hi))) / Math.log(base)),
  );
  const unit = powBase(base, p);
  const target = (hi - lo) / unit / Math.max(2, Math.floor(heightPx / (2.5 * labelHeightPx)));
  let stepUnits = niceAtLeast(target);
  let { min, max } = snapped(lo, hi, stepUnits * unit);
  let done = false;
  for (let n = 0; n < MAX_TICK_STEPS; n++) {
    const step = stepUnits * unit;
    const count = Math.round((max - min) / step);
    const spacing = heightPx / count;
    if (spacing >= labelHeightPx + 2 || count <= 1) {
      done = true;
      break;
    }
    stepUnits = nextNice(stepUnits);
    ({ min, max } = snapped(lo, hi, stepUnits * unit));
  }
  const step = stepUnits * unit;
  const count = Math.round((max - min) / step);
  const countOk = Number.isFinite(count) && count >= 0 && count <= MAX_TICK_COUNT;
  if (!done || !countOk || !Number.isFinite(min) || !Number.isFinite(max) || min >= max) {
    return null;
  }
  const ticks: number[] = [];
  for (let i = 0; i <= count; i++) ticks.push(round12(min + i * step));
  if (ticks.some((t) => !Number.isFinite(t))) return null;
  // Short plot: the loop leaves ≥ 3 ticks only with spacing ≥ label + 2; two ticks h px apart
  // collide below one gap.
  if (ticks.length === 2 && !(heightPx >= labelHeightPx + 2)) {
    return { min, max, ticks: [nearerZero(ticks[0] ?? NaN, ticks[1] ?? NaN)] };
  }
  // Collision check: the drawn gaps, through the renderer's y. Rounded duplicates (gap 0) fail.
  if (!ticksFit(ticks, min, max, heightPx, labelHeightPx)) return null;
  return { min, max, ticks };
}

/**
 * The fallback (= dash-scales `extreme_ticks`): [lo, lo/2 + hi/2, hi] when the midpoint is strictly
 * inside and both drawn gaps hold a label; [lo, hi] when the plot is at least label + 2 tall; else
 * the end nearer zero (lo on a tie). Equal ends are first widened toward zero.
 */
export function extremeTicks(
  a: number,
  b: number,
  heightPx: number,
  labelHeightPx: number,
): ValueTicks {
  let lo: number;
  let hi: number;
  if (a < b) {
    lo = a;
    hi = b;
  } else if (a > 0) {
    lo = a / 2;
    hi = a;
  } else if (a < 0) {
    lo = a;
    hi = a / 2;
  } else {
    lo = 0;
    hi = 1;
  }
  const m = lo / 2 + hi / 2;
  const three = m > lo && m < hi && ticksFit([lo, m, hi], lo, hi, heightPx, labelHeightPx);
  const ticks = three
    ? [lo, m, hi]
    : heightPx >= labelHeightPx + 2
      ? [lo, hi]
      : [nearerZero(lo, hi)];
  return { min: lo, max: hi, ticks };
}

/** niceValueTicks(...) ?? extremeTicks(dataMin, dataMax, heightPx, labelHeightPx). Always ends. */
export function valueTicks(
  dataMin: number,
  dataMax: number,
  heightPx: number,
  labelHeightPx: number,
  base: 1000 | 1024,
): ValueTicks {
  return (
    niceValueTicks(dataMin, dataMax, heightPx, labelHeightPx, base) ??
    extremeTicks(dataMin, dataMax, heightPx, labelHeightPx)
  );
}
