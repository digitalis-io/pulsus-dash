/**
 * Histogram bins (T21-013; plan #208 Part 1 §4.2): a line-for-line port of the #154 reference that
 * produced the T21 fixtures, including the allocation-free k and 2⁵² checks, the widening steps,
 * the log re-clamp to the exact min and max, the guard walk k − 1 … 1 and the terminal log rule.
 */
import { formatValue, type Unit } from '../../i18n/format';
import type { HistogramOptions } from './histogram';

export const MAX_BINS = 200;

/** Type-7 quantile of ascending `s`: x_j·(1 − g) + x_{j+1}·g (no difference term). */
export function q7(s: Float64Array, p: number): number {
  const h = (s.length - 1) * p;
  const j = Math.floor(h);
  const g = h - j;
  const a = s[j] ?? NaN;
  return j + 1 < s.length ? a * (1 - g) + (s[j + 1] ?? NaN) * g : a;
}

/** The bin of an `x` inside [e₀, e_k]: binary search, the last bin closed. */
export function binIndexClamped(edges: Float64Array, x: number): number {
  const k = edges.length - 1;
  let lo = 0;
  let hi = k;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (x >= (edges[m + 1] ?? Infinity)) lo = m + 1;
    else hi = m;
  }
  return Math.min(lo, k - 1);
}

const NICE_MANTISSAS = [1, 2, 2.5, 5] as const;
const MIN_NORMAL = 2.2250738585072014e-308;
/** The width and q checks before any allocation (T21-013). */
const MAX_Q = 2 ** 52;
/** Widening steps after the first (`nextNice` while k > 200). */
const MAX_WIDEN_STEPS = 4;
/** The count of the only fallback (T21-013). */
const FALLBACK_COUNT = 20;

interface Nice {
  readonly m: number;
  readonly e: number;
  readonly v: number;
}

/** The least m·10ᵉ ≥ x, m ∈ {1, 2, 2.5, 5}; null for 0, subnormal or non-finite x. */
function nice(x: number): Nice | null {
  if (!(x > 0) || x < MIN_NORMAL || !Number.isFinite(x)) return null;
  let e = Math.floor(Math.log10(x));
  for (let step = 0; step < 3; step++) {
    for (const m of NICE_MANTISSAS) {
      const v = m * 10 ** e;
      if (v >= x) return { m, e, v };
    }
    e++;
  }
  return null;
}

function nextNice(n: Nice): Nice {
  const i = NICE_MANTISSAS.indexOf(n.m as (typeof NICE_MANTISSAS)[number]);
  const m = NICE_MANTISSAS[i + 1];
  return m !== undefined
    ? { m, e: n.e, v: m * 10 ** n.e }
    : { m: 1, e: n.e + 1, v: 10 ** (n.e + 1) };
}

/** E with S = 10^E: ⌈log10 max(|min|, |max|)⌉ clamped to [−307, 308]; 0 when both are 0. */
export function scaleOf(min: number, max: number): number {
  const a = Math.max(Math.abs(min), Math.abs(max));
  return a === 0 ? 0 : Math.min(308, Math.max(-307, Math.ceil(Math.log10(a))));
}

/** k + 1 evenly spaced edges without overflow, with exact ends. */
function lerp(min: number, max: number, k: number): Float64Array {
  const e = new Float64Array(k + 1);
  for (let i = 0; i <= k; i++) e[i] = min * (1 - i / k) + max * (i / k);
  e[0] = min;
  e[k] = max;
  return e;
}

type Aligned =
  | { readonly kind: 'edges'; readonly edges: Float64Array }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'tooMany' };

/** Width-aligned edges over [min, max] (axis space), k checked before allocation. */
function aligned(
  min: number,
  max: number,
  wn: number,
  E: number,
  niceW: Nice | null,
  userW: number | null,
): Aligned {
  const S = 10 ** E;
  const a = min / S / wn;
  const b = max / S / wn;
  const q0 = Math.floor(a);
  let q1 = Math.ceil(b);
  if (q1 === q0) q1 = q0 + 1;
  const k = q1 - q0;
  if (!Number.isInteger(k) || Math.abs(q0) > MAX_Q || Math.abs(q1) > MAX_Q)
    return { kind: 'invalid' };
  if (k > MAX_BINS) return { kind: 'tooMany' };
  const e = new Float64Array(k + 1);
  for (let i = 0; i <= k; i++)
    e[i] = niceW ? (q0 + i) * niceW.m * 10 ** (niceW.e + E) : (q0 + i) * (userW ?? NaN);
  e[0] = Math.min(e[0] ?? NaN, min);
  e[k] = Math.max(e[k] ?? NaN, max);
  return { kind: 'edges', edges: e };
}

/** Whether two adjacent edges give the same `formatValue(e, unit, 17)`. */
function labelsCollide(edges: Float64Array, unit: Unit): boolean {
  let prev = '';
  for (let i = 0; i < edges.length; i++) {
    const s = formatValue(edges[i] ?? NaN, unit, 17);
    if (i > 0 && s === prev) return true;
    prev = s;
  }
  return false;
}

/** The T21-013 guard: finite, strictly increasing, display-distinct, and (log) positive. */
function guardOk(e: Float64Array, log: boolean, unit: Unit): boolean {
  if (labelsCollide(e, unit)) return false;
  for (let i = 0; i < e.length; i++) {
    const x = e[i] ?? NaN;
    if (!Number.isFinite(x)) return false;
    if (log && !(x > 0 && Number.isFinite(Math.log10(x)))) return false;
    if (i > 0) {
      const p = e[i - 1] ?? NaN;
      if (!(x > p)) return false;
      if (log && !(Math.log10(x) > Math.log10(p))) return false;
    }
  }
  return true;
}

/** Whether a frame with `edges` is display-collapsed (adjacent edges equal at 17 digits). */
export function displayCollapsed(edges: Float64Array, unit: Unit): boolean {
  return labelsCollide(edges, unit);
}

/**
 * The bin edges of the drawable values (T21-013): `sortedValues` ascending in value units; edges in
 * value units, exact min and max. Binning runs on x = v (linear) or log10 v (log); widths are
 * normalised by S = 10^`scaleOf`; then the display guard and the terminal log rule.
 */
export function binEdges(
  sortedValues: Float64Array,
  o: HistogramOptions,
): { edges: Float64Array; widenedTo: number | null; adjusted: number | null } {
  const log = o.scale === 'log';
  const unit = o.unit;
  const n = sortedValues.length;
  const minV = sortedValues[0] ?? NaN;
  const maxV = sortedValues[n - 1] ?? NaN;
  const X = log ? sortedValues.map(Math.log10) : sortedValues;
  const min = X[0] ?? NaN;
  const max = X[n - 1] ?? NaN;
  const toVal = (x: number): number => (log ? 10 ** x : x);
  if (minV === maxV) {
    // Within the domain nice(|v|·0.1) is always defined.
    const u = minV === 0 ? 1 : (nice(Math.abs(minV) * 0.1)?.v ?? 1);
    return terminal(Float64Array.from([minV - u / 2, minV + u / 2]), log, minV, maxV, null, null);
  }
  const countEdges = (kk: number): Float64Array => {
    const e = lerp(min, max, kk).map(toVal);
    e[0] = minV;
    e[kk] = maxV;
    return e;
  };
  const E = scaleOf(min, max);
  const S = 10 ** E;
  let widened = false;
  let widenedTo: number | null = null;
  let adjusted: number | null = null;
  let edgesX: Float64Array | null = null;
  let count: number | null = null;
  if (o.binMode === 'count') count = Math.min(MAX_BINS, Math.max(1, o.binCount));
  else {
    let niceW: Nice | null = null;
    let userW: number | null = null;
    if (o.binMode === 'width') {
      userW = o.binWidth;
      if (!((userW ?? 0) / S >= MIN_NORMAL)) {
        niceW = nice((max / S - min / S) / MAX_BINS);
        userW = null;
        widened = true;
      }
    } else {
      const xs = X.map((x) => x / S);
      const span = (xs[n - 1] ?? NaN) - (xs[0] ?? NaN);
      const iqr = q7(xs, 0.75) - q7(xs, 0.25);
      let k0 = iqr > 0 ? Math.ceil(span / (2 * iqr * n ** (-1 / 3))) : Math.ceil(Math.log2(n)) + 1;
      k0 = Math.min(MAX_BINS, Math.max(5, k0));
      niceW = nice(span / k0);
    }
    let res: Aligned;
    for (let steps = 0; ; steps++) {
      if (!niceW && !userW) {
        res = { kind: 'invalid' };
        break;
      }
      res = aligned(
        min,
        max,
        niceW ? niceW.m * 10 ** niceW.e : (userW ?? NaN) / S,
        E,
        niceW,
        niceW ? null : userW,
      );
      if (res.kind !== 'tooMany') break;
      if (steps >= MAX_WIDEN_STEPS) {
        res = { kind: 'invalid' };
        break;
      }
      niceW = niceW ? nextNice(niceW) : nice((max / S - min / S) / MAX_BINS);
      userW = null;
      widened = true;
    }
    if (res.kind === 'edges') {
      edgesX = res.edges;
      if (widened && niceW) widenedTo = niceW.v * S;
    } else {
      count = FALLBACK_COUNT;
      adjusted = FALLBACK_COUNT;
    }
  }
  let e = edgesX ? edgesX.map(toVal) : countEdges(count ?? FALLBACK_COUNT);
  if (edgesX && log) {
    e[0] = Math.min(e[0] ?? NaN, minV);
    e[e.length - 1] = Math.max(e[e.length - 1] ?? NaN, maxV);
  }
  if (adjusted !== null) adjusted = e.length - 1;
  if (!guardOk(e, log, unit)) {
    let kk = e.length - 2;
    let found: Float64Array | null = null;
    while (kk >= 1) {
      const c = countEdges(kk);
      if (guardOk(c, log, unit)) {
        found = c;
        break;
      }
      kk--;
    }
    e = found ?? Float64Array.from([minV, maxV]);
    adjusted = e.length - 1;
  }
  return terminal(e, log, minV, maxV, widenedTo, adjusted);
}

/** The terminal log rule: log10 e₀ < log10 e_k, else one decade centred on log10 min. */
function terminal(
  e: Float64Array,
  log: boolean,
  minV: number,
  maxV: number,
  widenedTo: number | null,
  adjusted: number | null,
): { edges: Float64Array; widenedTo: number | null; adjusted: number | null } {
  if (log && !(Math.log10(e[0] ?? NaN) < Math.log10(e[e.length - 1] ?? NaN))) {
    const L = Math.log10(minV);
    return {
      edges: Float64Array.from([Math.min(10 ** (L - 0.5), minV), Math.max(10 ** (L + 0.5), maxV)]),
      widenedTo,
      adjusted: 1,
    };
  }
  return { edges: e, widenedTo, adjusted };
}

/** The bin of `x`: −1 outside [e₀, e_k]; [eᵢ, eᵢ₊₁), the last bin closed. */
export function binIndex(edges: Float64Array, x: number): number {
  const k = edges.length - 1;
  if (k < 1 || !(x >= (edges[0] ?? NaN) && x <= (edges[k] ?? NaN))) return -1;
  return binIndexClamped(edges, x);
}
