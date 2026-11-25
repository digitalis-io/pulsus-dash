/**
 * Histogram transforms over raw values (T21-012 to T21-016; plan #208 Part 1 §3.2, §4). Pure: the
 * per-panel worker (`histogram.worker.ts`) runs `histogram()`; the frame and the panel use the
 * rest. The bins are a port of the #154 reference that produced the T21 fixtures
 * (`fixtures/histogram.json`, shared with the engine port).
 */
import type { SummaryFacts } from '../../engine/api';
import { seriesColourIndex } from '../../engine/canvas2d/palette';
import { CATEGORY_PATTERNS, LINE_DASHES, OTHER_DASH, OTHER_PATTERN } from '../../engine/patterns';
import type { Completeness } from '../../data/decode';
import {
  seriesName,
  type HistogramCoverage,
  type HistogramFrame,
  type HistogramGroup,
  type Labels,
  type SeriesFrame,
  type SourceGroup,
} from '../../data/frames';
import { formatValue, type Unit } from '../../i18n/format';
import { t } from '../../i18n/t';
import { binEdges, binIndexClamped, displayCollapsed, q7 } from './bins';
import { checkStep, type Slicer } from './slice';

export { MAX_BINS, binEdges, binIndex, displayCollapsed, scaleOf } from './bins';

/** Σ samples above this → `tooMany` (T21-012). */
export const MAX_HIST_SAMPLES = 2_000_000;
/** Drawn groups before `other (n)` (T21-014). */
export const DRAWN_GROUPS = 7;
/** The drawable domain: v = 0 or DOMAIN_LO ≤ |v| ≤ DOMAIN_HI (T21-012). */
export const DOMAIN_LO = 1e-290;
export const DOMAIN_HI = 1e290;

export interface HistogramOptions {
  readonly binMode: 'auto' | 'count' | 'width';
  readonly binCount: number;
  readonly binWidth: number | null;
  readonly scale: 'linear' | 'log';
  readonly groupBy: string | null;
  readonly groupMode: 'stack' | 'overlay';
  readonly cumulative: 'none' | 'cdf' | 'ecdf';
  /** The panel unit, for the T21-013 display guard. */
  readonly unit: Unit;
}

export type HistogramResult =
  | { readonly kind: 'frame'; readonly frame: HistogramFrame }
  /** received 0. */
  | { readonly kind: 'empty'; readonly coverage: HistogramCoverage }
  /** drawable 0. */
  | {
      readonly kind: 'noneShown';
      readonly coverage: HistogramCoverage;
      readonly sourceGroups: readonly SourceGroup[];
    }
  | { readonly kind: 'tooMany'; readonly samples: number; readonly query: Completeness }
  /** Interim (H8a) until #212: a series has an `le` label; nothing is binned. */
  | { readonly kind: 'buckets'; readonly leSeries: number; readonly query: Completeness };

/** Plot-relative CSS px of the bars (T21-015): `top`/`bottom` are groups × k, y from the top. */
export interface BinLayout {
  readonly width: number;
  readonly height: number;
  readonly edgePx: Float64Array;
  readonly countMax: number;
  readonly mode: 'stack' | 'overlay';
  readonly top: Float64Array;
  readonly bottom: Float64Array;
}

/** One part of the coverage meter (T21-016); the exclusion parts open the popover. */
export type MeterPart =
  | { readonly kind: 'query' | 'duplicates' | 'widened' | 'adjusted'; readonly text: string }
  | { readonly kind: 'nonPositive' | 'infinite' | 'outOfRange'; readonly text: string };

/** CSR entries between two `checkStep` calls in the selection scans. */
const SCAN_STEP = 10_000;

const NONE: Unit = { kind: 'none' };
const collator = new Intl.Collator('en', { numeric: true });

/** Natural name order, then code-unit order (T21-014). */
function nameOrder(a: string, b: string): number {
  return collator.compare(a, b) || codeUnitOrder(a, b);
}

function codeUnitOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const inDomain = (v: number): boolean =>
  v === 0 || (Math.abs(v) >= DOMAIN_LO && Math.abs(v) <= DOMAIN_HI);

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/**
 * A source group's key: FNV-1a 64 over the UTF-8 of `${label}\u0000${value}`, or of
 * `${label}\u0001` when the label is absent, as 16 lower-case hex digits.
 */
export function groupKey(label: string, value: string | null): string {
  const text = value === null ? `${label}\u0001` : `${label}\u0000${value}`;
  let h = FNV_OFFSET;
  for (const byte of new TextEncoder().encode(text)) {
    h ^= BigInt(byte);
    h = (h * FNV_PRIME) & MASK_64;
  }
  return h.toString(16).padStart(16, '0');
}

function coverageOf(q: Completeness, c: Partial<HistogramCoverage> = {}): HistogramCoverage {
  return {
    query: q,
    received: 0,
    drawable: 0,
    nonPositive: 0,
    infinite: 0,
    outOfRange: 0,
    duplicates: 0,
    conflicts: 0,
    widenedTo: null,
    adjusted: null,
    ...c,
  };
}

/**
 * The merged finite values of one key (T22-003) and its ±∞ samples, counted before the merge.
 * Range: finite samples by timestamp, max on a shared one (+1 conflict). Instant: the latest
 * finite sample, max on a tie (+1 conflict).
 */
function mergeKey(
  series: readonly SeriesFrame[],
  source: 'instant' | 'range',
): { values: number[]; conflicts: number; infinite: number } {
  let infinite = 0;
  for (const s of series)
    for (const v of s.values) if (v === Infinity || v === -Infinity) infinite += 1;
  if (source === 'instant') {
    let at = -Infinity;
    let value: number | null = null;
    let conflicts = 0;
    for (const s of series) {
      for (let i = s.values.length - 1; i >= 0; i--) {
        const v = s.values[i] ?? NaN;
        if (!Number.isFinite(v)) continue;
        const ts = s.timestamps[i] ?? NaN;
        if (value === null || ts > at) {
          at = ts;
          value = v;
        } else if (ts === at) {
          conflicts += 1;
          value = Math.max(value, v);
        }
        break;
      }
    }
    return { values: value === null ? [] : [value], conflicts, infinite };
  }
  const only = series.length === 1 ? series[0] : undefined;
  if (only !== undefined) {
    const values: number[] = [];
    for (const v of only.values) if (Number.isFinite(v)) values.push(v);
    return { values, conflicts: 0, infinite };
  }
  const byTs = new Map<number, number>();
  let conflicts = 0;
  for (const s of series) {
    for (let i = 0; i < s.values.length; i++) {
      const v = s.values[i] ?? NaN;
      if (!Number.isFinite(v)) continue;
      const ts = s.timestamps[i] ?? NaN;
      const was = byTs.get(ts);
      if (was === undefined) byTs.set(ts, v);
      else {
        conflicts += 1;
        byTs.set(ts, Math.max(was, v));
      }
    }
  }
  return { values: [...byTs.values()], conflicts, infinite };
}

/**
 * A raw group value as a name (T22-004 final pass): quoted as `seriesName` quotes values when it
 * equals `other`, ends in ` (<digits>)` or equals `${L} absent`.
 */
function shownValue(label: string, v: string): string {
  if (v === 'other' || / \(\d+\)$/.test(v) || v === t('hist.absent', { label }))
    return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
  return v;
}

interface Building {
  readonly key: string;
  name: string;
  readonly labels: Labels;
  received: number;
  nonPositive: number;
  infinite: number;
  outOfRange: number;
  readonly values: number[];
}

/**
 * The histogram of `input` (T21-012 to T21-016; plan §4.1): `le` series → `buckets`; more than
 * `MAX_HIST_SAMPLES` samples → `tooMany`; then per key the merge and the exclusions, the source
 * groups, the bins, the drawn groups, the counts, the CSR of contributions and the quantiles.
 */
export function histogram(
  input: readonly SeriesFrame[],
  source: 'instant' | 'range',
  o: HistogramOptions,
  q: Completeness,
): HistogramResult {
  let leSeries = 0;
  let samples = 0;
  for (const s of input) {
    if (s.labels['le'] !== undefined) leSeries += 1;
    samples += s.timestamps.length;
  }
  if (leSeries > 0) return { kind: 'buckets', leSeries, query: q };
  if (samples > MAX_HIST_SAMPLES) return { kind: 'tooMany', samples, query: q };

  const log = o.scale === 'log';
  const L = o.groupBy;
  const byKey = new Map<string, SeriesFrame[]>();
  for (const s of input) {
    const list = byKey.get(s.key);
    if (list === undefined) byKey.set(s.key, [s]);
    else list.push(s);
  }
  const keys = [...byKey.keys()].sort(codeUnitOrder);
  const building = new Map<string, Building>();
  const keyValues: number[][] = [];
  const keyGroup: Building[] = [];
  let duplicates = 0;
  let conflicts = 0;
  for (const key of keys) {
    const list = byKey.get(key) ?? [];
    const labels = list[0]?.labels ?? {};
    duplicates += list.length - 1;
    const m = mergeKey(list, source);
    conflicts += m.conflicts;
    const v = L === null ? null : (labels[L] ?? null);
    const gk = L === null ? 'all' : groupKey(L, v);
    let b = building.get(gk);
    if (b === undefined) {
      let name = t('hist.allValues');
      if (L !== null) name = v === null ? t('hist.absent', { label: L }) : shownValue(L, v);
      b = {
        key: gk,
        name,
        labels: L !== null && v !== null ? { [L]: v } : {},
        received: 0,
        nonPositive: 0,
        infinite: 0,
        outOfRange: 0,
        values: [],
      };
      building.set(gk, b);
    }
    b.received += m.values.length + m.infinite;
    b.infinite += m.infinite;
    const kept: number[] = [];
    for (const x of m.values) {
      if (!inDomain(x)) b.outOfRange += 1;
      else if (log && !(x > 0)) b.nonPositive += 1;
      else kept.push(x);
    }
    for (const x of kept) b.values.push(x);
    keyValues.push(kept);
    keyGroup.push(b);
  }

  // Names still equal get ` (1)`, ` (2)`, … in key order.
  const byName = new Map<string, Building[]>();
  for (const b of building.values()) {
    const list = byName.get(b.name);
    if (list === undefined) byName.set(b.name, [b]);
    else list.push(b);
  }
  for (const list of byName.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => codeUnitOrder(a.key, b.key));
    list.forEach((b, i) => {
      b.name = `${b.name} (${i + 1})`;
    });
  }
  const ordered = [...building.values()].sort((a, b) => nameOrder(a.name, b.name));

  let received = 0;
  let drawable = 0;
  let nonPositive = 0;
  let infinite = 0;
  let outOfRange = 0;
  for (const b of ordered) {
    received += b.received;
    drawable += b.values.length;
    nonPositive += b.nonPositive;
    infinite += b.infinite;
    outOfRange += b.outOfRange;
  }
  const base = { received, drawable, nonPositive, infinite, outOfRange, duplicates, conflicts };
  const sourceOf = (b: Building, drawnAs: number): SourceGroup => ({
    key: b.key,
    name: b.name,
    labels: b.labels,
    received: b.received,
    drawable: b.values.length,
    nonPositive: b.nonPositive,
    infinite: b.infinite,
    outOfRange: b.outOfRange,
    drawnAs,
  });
  if (received === 0) return { kind: 'empty', coverage: coverageOf(q, base) };
  if (drawable === 0)
    return {
      kind: 'noneShown',
      coverage: coverageOf(q, base),
      sourceGroups: ordered.map((b) => sourceOf(b, -1)),
    };

  // Sorted values per source group (name order, each ascending), then the pooled sort.
  const sortedValues = new Float64Array(drawable);
  const sortedOffsets = new Uint32Array(ordered.length + 1);
  let at = 0;
  ordered.forEach((b, i) => {
    const part = Float64Array.from(b.values).sort();
    sortedValues.set(part, at);
    at += part.length;
    sortedOffsets[i + 1] = at;
  });
  const pooled = Float64Array.from(sortedValues).sort();
  const bins = binEdges(pooled, o);
  const edges = bins.edges;
  const k = edges.length - 1;

  const { groups, drawnAs } = drawnGroups(ordered, L !== null);
  const sourceGroups = ordered.map((b, i) => sourceOf(b, drawnAs[i] ?? -1));
  const sourceIndex = new Map(ordered.map((b, i) => [b, i]));

  // Counts and the CSR of contributions per series (by key, bins ascending, count > 0).
  const counts = new Float64Array(groups.length * k);
  const offsets = new Uint32Array(keys.length + 1);
  const entryBins: number[] = [];
  const entryCounts: number[] = [];
  const scratch = new Float64Array(k);
  const series = keys.map((key, si) => {
    const group = keyGroup[si];
    const sg = group === undefined ? 0 : (sourceIndex.get(group) ?? 0);
    const gi = drawnAs[sg] ?? -1;
    for (const x of keyValues[si] ?? []) {
      const i = binIndexClamped(edges, x);
      scratch[i] = (scratch[i] ?? 0) + 1;
      if (gi >= 0) counts[gi * k + i] = (counts[gi * k + i] ?? 0) + 1;
    }
    for (let i = 0; i < k; i++) {
      const c = scratch[i] ?? 0;
      if (c > 0) {
        entryBins.push(i);
        entryCounts.push(c);
        scratch[i] = 0;
      }
    }
    offsets[si + 1] = entryBins.length;
    const labels = byKey.get(key)?.[0]?.labels ?? {};
    return { key, name: seriesName(labels), labels, sourceGroup: sg };
  });

  return {
    kind: 'frame',
    frame: {
      edges,
      sourceGroups,
      groups,
      counts,
      series,
      contrib: {
        offsets,
        bins: Uint16Array.from(entryBins),
        counts: Float64Array.from(entryCounts),
      },
      sorted: { values: sortedValues, offsets: sortedOffsets },
      quantiles: { p25: q7(pooled, 0.25), p50: q7(pooled, 0.5), p75: q7(pooled, 0.75) },
      countBasis: source === 'instant' ? 'series' : 'samples',
      collapsed: displayCollapsed(edges, o.unit),
      coverage: coverageOf(q, { ...base, widenedTo: bins.widenedTo, adjusted: bins.adjusted }),
    },
  };
}

/**
 * The drawn groups (T21-014): without `groupBy` the one group (`solid`, colour 0); else the 7
 * largest by drawable (ties by name) in name order, with patterns, dashes and series colours, and
 * the rest as `other (n)`, last. Groups with drawable 0 are not drawn (`drawnAs` −1).
 */
function drawnGroups(
  ordered: readonly Building[],
  grouped: boolean,
): { groups: HistogramGroup[]; drawnAs: Int32Array } {
  const drawnAs = new Int32Array(ordered.length).fill(-1);
  const groups: HistogramGroup[] = [];
  const only = ordered[0];
  if (!grouped) {
    if (only !== undefined && only.values.length > 0) {
      drawnAs[0] = 0;
      groups.push({
        key: only.key,
        name: only.name,
        colourIndex: 0,
        pattern: 'solid',
        dash: LINE_DASHES[0],
        members: [0],
        drawable: only.values.length,
      });
    }
    return { groups, drawnAs };
  }
  const candidates = ordered
    .map((b, i) => ({ b, i }))
    .filter((x) => x.b.values.length > 0)
    .sort((x, y) => y.b.values.length - x.b.values.length || x.i - y.i);
  const top = candidates.slice(0, DRAWN_GROUPS).sort((x, y) => x.i - y.i);
  const rest = candidates.slice(DRAWN_GROUPS).sort((x, y) => x.i - y.i);
  top.forEach(({ b, i }, j) => {
    drawnAs[i] = j;
    groups.push({
      key: b.key,
      name: b.name,
      colourIndex: seriesColourIndex({ key: b.key, labels: b.labels }),
      pattern: CATEGORY_PATTERNS[j] ?? 'solid',
      dash: LINE_DASHES[j] ?? [],
      members: [i],
      drawable: b.values.length,
    });
  });
  if (rest.length > 0) {
    const j = groups.length;
    for (const { i } of rest) drawnAs[i] = j;
    groups.push({
      key: 'other',
      name: t('hist.other', { n: rest.length }),
      colourIndex: -1,
      pattern: OTHER_PATTERN,
      dash: OTHER_DASH,
      members: rest.map((x) => x.i),
      drawable: rest.reduce((n, x) => n + x.b.values.length, 0),
    });
  }
  return { groups, drawnAs };
}

/**
 * Edge labels (T21-013): the least d in 3…17 at which every adjacent label differs; a collapsed
 * frame has the one label "≈ " + `formatValue(e₀)`.
 */
export function binLabels(edges: Float64Array, unit: Unit): string[] {
  if (displayCollapsed(edges, unit))
    return [t('hist.collapsed', { value: formatValue(edges[0] ?? NaN, unit) })];
  let labels: string[] = [];
  for (let d = 3; d <= 17; d++) {
    labels = Array.from(edges, (e) => formatValue(e, unit, d));
    if (labels.every((x, i) => i === 0 || x !== labels[i - 1])) return labels;
  }
  return labels;
}

/** "from – to" of bin `i` from `binLabels`, or the one label of a collapsed frame. */
export function binRangeText(f: HistogramFrame, labels: readonly string[], i: number): string {
  if (f.collapsed) return labels[0] ?? '';
  return t('hist.range', { from: labels[i] ?? '', to: labels[i + 1] ?? '' });
}

/** The CDF per bin of drawn group `group`, or of the panel (null): Σ counts ≤ i / drawable. */
export function cdf(f: HistogramFrame, group: number | null): Float64Array {
  const k = f.edges.length - 1;
  const out = new Float64Array(k);
  const total = group === null ? f.coverage.drawable : (f.groups[group]?.drawable ?? 0);
  if (total === 0) return out;
  let sum = 0;
  for (let i = 0; i < k; i++) {
    if (group === null) for (let g = 0; g < f.groups.length; g++) sum += f.counts[g * k + i] ?? 0;
    else sum += f.counts[group * k + i] ?? 0;
    out[i] = sum / total;
  }
  return out;
}

/** The count of values ≤ x in the ascending slice [lo, hi). */
function upperBound(a: Float64Array, lo: number, hi: number, x: number): number {
  let l = lo;
  let h = hi;
  while (l < h) {
    const m = (l + h) >> 1;
    if ((a[m] ?? NaN) <= x) l = m + 1;
    else h = m;
  }
  return l - lo;
}

/** The exact ECDF at `x` over source groups' sorted slices: Σ upper bounds / Σ lengths. */
export function ecdfAt(f: HistogramFrame, sourceGroups: readonly number[], x: number): number {
  let below = 0;
  let total = 0;
  for (const g of sourceGroups) {
    const lo = f.sorted.offsets[g] ?? 0;
    const hi = f.sorted.offsets[g + 1] ?? lo;
    below += upperBound(f.sorted.values, lo, hi, x);
    total += hi - lo;
  }
  return total === 0 ? 0 : below / total;
}

/**
 * The forward scale of each edge (T21-013): (f(eᵢ)/2 − f(e₀)/2) / (f(e_k)/2 − f(e₀)/2) · W, f the
 * identity or log10; px[0] = 0 and px[k] = W exactly.
 */
export function edgePx(edges: Float64Array, scale: 'linear' | 'log', width: number): Float64Array {
  const f = scale === 'log' ? Math.log10 : (x: number): number => x;
  const k = edges.length - 1;
  const a = f(edges[0] ?? NaN) / 2;
  const b = f(edges[k] ?? NaN) / 2;
  const px = new Float64Array(edges.length);
  for (let i = 0; i <= k; i++) px[i] = ((f(edges[i] ?? NaN) / 2 - a) / (b - a)) * width;
  px[0] = 0;
  px[k] = width;
  return px;
}

/** Bar rectangles in plot CSS px (T21-014, T21-015); the baseline is y = height. */
export function binLayout(
  f: HistogramFrame,
  scale: 'linear' | 'log',
  mode: 'stack' | 'overlay',
  width: number,
  height: number,
): BinLayout {
  const k = f.edges.length - 1;
  const n = f.groups.length;
  let countMax = 0;
  for (let i = 0; i < k; i++) {
    let sum = 0;
    for (let g = 0; g < n; g++) {
      const c = f.counts[g * k + i] ?? 0;
      sum += c;
      if (mode === 'overlay') countMax = Math.max(countMax, c);
    }
    if (mode === 'stack') countMax = Math.max(countMax, sum);
  }
  if (countMax === 0) countMax = 1;
  const top = new Float64Array(n * k);
  const bottom = new Float64Array(n * k);
  const y = (c: number): number => height - (c / countMax) * height;
  for (let i = 0; i < k; i++) {
    let cum = 0;
    for (let g = 0; g < n; g++) {
      const c = f.counts[g * k + i] ?? 0;
      const from = mode === 'stack' ? cum : 0;
      bottom[g * k + i] = y(from);
      top[g * k + i] = y(from + c);
      cum += c;
    }
  }
  return { width, height, edgePx: edgePx(f.edges, scale, width), countMax, mode, top, bottom };
}

/**
 * The bin at `px` (T21-015): −1 outside [px[0], px[k]]; else the largest i with px[i] ≤ px
 * (gaps and boundaries go right), and px[k] → the last bin.
 */
export function binAtPx(edgePx: Float64Array, px: number): number {
  const k = edgePx.length - 1;
  if (!(px >= (edgePx[0] ?? NaN) && px <= (edgePx[k] ?? NaN))) return -1;
  if (px === edgePx[k]) return k - 1;
  let lo = 0;
  let hi = k - 1;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if ((edgePx[m] ?? NaN) <= px) lo = m;
    else hi = m - 1;
  }
  return lo;
}

/** The minimum hit height of a segment in CSS px; the extra above a column's top segment. */
const HIT_MIN_PX = 4;
const HIT_TOP_PX = 3;

/** The bin segment under (x, y) in plot CSS px, or null (T21-015). */
export function hitTestBin(
  f: HistogramFrame,
  l: BinLayout,
  xCss: number,
  yCss: number,
): { index: number; group: number } | null {
  const i = binAtPx(l.edgePx, xCss);
  if (i < 0) return null;
  const k = f.edges.length - 1;
  const n = f.groups.length;
  const countOf = (g: number): number => f.counts[g * k + i] ?? 0;
  const topOf = (g: number): number => l.top[g * k + i] ?? NaN;
  const bottomOf = (g: number): number => l.bottom[g * k + i] ?? NaN;
  if (l.mode === 'stack') {
    let last = -1;
    for (let g = 0; g < n; g++) if (countOf(g) > 0) last = g;
    for (let g = last; g >= 0; g--) {
      if (countOf(g) <= 0) continue;
      let top = Math.min(topOf(g), bottomOf(g) - HIT_MIN_PX);
      if (g === last) top -= HIT_TOP_PX;
      if (yCss >= top && yCss <= bottomOf(g)) return { index: i, group: g };
    }
    return null;
  }
  let near = -1;
  let nearD = Infinity;
  for (let g = 0; g < n; g++) {
    if (countOf(g) <= 0) continue;
    const d = Math.abs(yCss - topOf(g));
    if (d <= HIT_MIN_PX && d < nearD) {
      near = g;
      nearD = d;
    }
  }
  if (near >= 0) return { index: i, group: near };
  let best = -1;
  for (let g = 0; g < n; g++) {
    if (countOf(g) <= 0 || !(yCss >= topOf(g) && yCss <= bottomOf(g))) continue;
    if (best < 0 || countOf(g) < countOf(best)) best = g;
  }
  return best >= 0 ? { index: i, group: best } : null;
}

/**
 * The bins a value brush over [p₀, p₁] selects (T21-015): pixel-extent overlap p₀ < px[i+1] and
 * p₁ > px[i] after ordering; from and to are raw edges; null when none.
 */
export function brushBins(
  f: HistogramFrame,
  l: BinLayout,
  p0: number,
  p1: number,
): { first: number; last: number; from: number; to: number } | null {
  const a = Math.min(p0, p1);
  const b = Math.max(p0, p1);
  const k = l.edgePx.length - 1;
  let first = -1;
  let last = -1;
  for (let i = 0; i < k; i++) {
    if (a < (l.edgePx[i + 1] ?? NaN) && b > (l.edgePx[i] ?? NaN)) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return null;
  return { first, last, from: f.edges[first] ?? NaN, to: f.edges[last + 1] ?? NaN };
}

/** The index of `x` in ascending `edges` by exact match, or −1. */
function edgeIndex(edges: Float64Array, x: number): number {
  let lo = 0;
  let hi = edges.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    const e = edges[m] ?? NaN;
    if (e === x) return m;
    if (e < x) lo = m + 1;
    else hi = m - 1;
  }
  return -1;
}

/**
 * Selection counts (T21-015): Σ `contrib` of the series whose key is in `keys`, into groups × k by
 * their source group's `drawnAs`; null when no key matches. Scans in 8 ms steps (T21-016).
 */
export async function selectedCounts(
  f: HistogramFrame,
  keys: ReadonlySet<string>,
  s: Slicer,
): Promise<Float64Array | null> {
  const k = f.edges.length - 1;
  const out = new Float64Array(f.groups.length * k);
  const { offsets, bins, counts } = f.contrib;
  let matched = false;
  let start = s.now();
  let scanned = 0;
  for (let si = 0; si < f.series.length; si++) {
    const lo = offsets[si] ?? 0;
    const hi = offsets[si + 1] ?? lo;
    scanned += hi - lo;
    if (scanned >= SCAN_STEP) {
      scanned = 0;
      start = await checkStep(s, start);
    }
    const sr = f.series[si];
    if (sr === undefined || !keys.has(sr.key)) continue;
    matched = true;
    const g = f.sourceGroups[sr.sourceGroup]?.drawnAs ?? -1;
    if (g < 0) continue;
    for (let e = lo; e < hi; e++) {
      const cell = g * k + (bins[e] ?? 0);
      out[cell] = (out[cell] ?? 0) + (counts[e] ?? 0);
    }
  }
  return matched ? out : null;
}

/**
 * The keys of the series in drawn `groups` with a value in bins [i₀, i₁), i₀ and i₁ the exact
 * edge indices of `from` and `to` (T21-015); sorted. Scans in 8 ms steps (T21-016).
 */
export async function binSeries(
  f: HistogramFrame,
  groups: readonly number[],
  from: number,
  to: number,
  s: Slicer,
): Promise<string[]> {
  const i0 = edgeIndex(f.edges, from);
  const i1 = edgeIndex(f.edges, to);
  if (i0 < 0 || i1 <= i0) return [];
  const wanted = new Set(groups);
  const { offsets, bins } = f.contrib;
  const out: string[] = [];
  let start = s.now();
  let scanned = 0;
  for (let si = 0; si < f.series.length; si++) {
    const lo = offsets[si] ?? 0;
    const hi = offsets[si + 1] ?? lo;
    scanned += hi - lo;
    if (scanned >= SCAN_STEP) {
      scanned = 0;
      start = await checkStep(s, start);
    }
    const sr = f.series[si];
    if (sr === undefined || !wanted.has(f.sourceGroups[sr.sourceGroup]?.drawnAs ?? -1)) continue;
    for (let e = lo; e < hi; e++) {
      const b = bins[e] ?? -1;
      if (b >= i0 && b < i1) {
        out.push(sr.key);
        break;
      }
    }
  }
  return out.sort(codeUnitOrder);
}

/** A count as every user-visible number is shown (T21-013): 2 000 000 → "2M". */
const countText = (n: number): string => formatValue(n, NONE);

/** The coverage meter parts in T21-016 order; none → `100 %`. */
export function histogramMeterParts(c: HistogramCoverage, unit: Unit): MeterPart[] {
  const parts: MeterPart[] = [];
  if (c.query.truncated) parts.push({ kind: 'query', text: t('hist.meter.truncated') });
  if (c.query.warnings.length > 0)
    parts.push({ kind: 'query', text: t('hist.meter.limited', { n: c.query.warnings.length }) });
  if (c.nonPositive > 0)
    parts.push({
      kind: 'nonPositive',
      text: t('hist.meter.nonPositive', { n: countText(c.nonPositive) }),
    });
  if (c.infinite > 0)
    parts.push({ kind: 'infinite', text: t('hist.meter.infinite', { n: countText(c.infinite) }) });
  if (c.outOfRange > 0)
    parts.push({
      kind: 'outOfRange',
      text: t('hist.meter.outOfRange', { n: countText(c.outOfRange) }),
    });
  if (c.duplicates > 0)
    parts.push({
      kind: 'duplicates',
      text: t('hist.meter.duplicates', { n: countText(c.duplicates), c: countText(c.conflicts) }),
    });
  if (c.widenedTo !== null)
    parts.push({
      kind: 'widened',
      text: t('hist.meter.widened', { w: formatValue(c.widenedTo, unit) }),
    });
  if (c.adjusted !== null)
    parts.push({ kind: 'adjusted', text: t('hist.meter.adjusted', { k: countText(c.adjusted) }) });
  if (parts.length === 0) parts.push({ kind: 'query', text: t('hist.meter.complete') });
  return parts;
}

/** The meter as one line: the parts joined by " · ". */
export function histogramCoverageText(c: HistogramCoverage, unit: Unit): string {
  return histogramMeterParts(c, unit)
    .map((p) => p.text)
    .join(' · ');
}

/**
 * The meter popover lines (T21-016): per source group with exclusions, in name order,
 * "name: a ≤ 0, b infinite, c out of range"; members of `other (n)` read "name (in other (n))".
 */
export function exclusionLines(
  sourceGroups: readonly SourceGroup[],
  groups: readonly HistogramGroup[],
): string[] {
  const lines: string[] = [];
  for (const s of sourceGroups) {
    const parts: string[] = [];
    if (s.nonPositive > 0) parts.push(t('hist.line.nonPositive', { n: countText(s.nonPositive) }));
    if (s.infinite > 0) parts.push(t('hist.line.infinite', { n: countText(s.infinite) }));
    if (s.outOfRange > 0) parts.push(t('hist.line.outOfRange', { n: countText(s.outOfRange) }));
    if (parts.length === 0) continue;
    const drawn = s.drawnAs >= 0 ? groups[s.drawnAs] : undefined;
    const name =
      drawn?.key === 'other' ? t('hist.line.inOther', { name: s.name, other: drawn.name }) : s.name;
    lines.push(t('hist.line', { name, parts: parts.join(', ') }));
  }
  return lines;
}

/** The plot text of `noneShown`: "No values shown: " + the exclusion parts of the meter. */
export function noneShownText(c: HistogramCoverage, unit: Unit): string {
  const parts = histogramMeterParts(c, unit).filter(
    (p) => p.kind === 'nonPositive' || p.kind === 'infinite' || p.kind === 'outOfRange',
  );
  return t('hist.notice.noneShown', { parts: parts.map((p) => p.text).join(' · ') });
}

/**
 * Summary facts (T21-015): "median <p50>; mode <from – to> (<count> of <drawable>)", the mode the
 * largest panel count (the lowest index on ties); `extent` the drawable minimum and maximum.
 */
export function summaryFacts(title: string, f: HistogramFrame, unit: Unit): SummaryFacts {
  const k = f.edges.length - 1;
  let mode = 0;
  let modeCount = -1;
  for (let i = 0; i < k; i++) {
    let sum = 0;
    for (let g = 0; g < f.groups.length; g++) sum += f.counts[g * k + i] ?? 0;
    if (sum > modeCount) {
      mode = i;
      modeCount = sum;
    }
  }
  const values = f.sorted.values;
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const text = t('hist.facts.current', {
    median: formatValue(f.quantiles?.p50 ?? NaN, unit),
    range: binRangeText(f, binLabels(f.edges, unit), mode),
    count: countText(Math.max(modeCount, 0)),
    drawable: countText(f.coverage.drawable),
  });
  return {
    subject: title,
    current: { text, series: title },
    change: null,
    extent: values.length > 0 ? { min, max } : null,
    baselineRatio: null,
  };
}
