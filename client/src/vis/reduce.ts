/**
 * Categorical transforms (T22 §5.2; plan #173 Part 1 §3.6, §4): pure and synchronous. The panel
 * merges duplicate series (T22-003, the shared `mergeKey`), reduces each series to a mark, names it
 * (T22-004, T22-005), sorts and caps the marks (T22-006), and derives the coverage meter text, the
 * table rows and CSV (T22-013) and the summary facts (T22-014) from every mark before the cap.
 */
import type { Sort } from '../boards/options';
import { csvCell } from '../data/csv';
import type { Completeness } from '../data/decode';
import {
  quoted,
  seriesName,
  type CategoryRow,
  type Coverage,
  type Labels,
  type Mark,
  type Reducer,
  type SeriesFrame,
  type State,
} from '../data/frames';
import type { SummaryFacts, ThresholdState, ValueRange } from '../engine/api';
import { browserTimeZone, formatValue, type Unit } from '../i18n/format';
import { t } from '../i18n/t';
import type { ExploreResult } from './autovis';
import { SCALAR_KEY } from './framePlan';
import { mergeKey } from './merge';
import { SEVERITY, stateOf, type Thresholds } from './thresholds';

export type { Sort };

/** The most bars a bar chart draws (T22-006), before the label fit. */
export const BAR_CAP = 200;
/** The least category band of a bar, in CSS px (T22-004). */
const BAND_PX = 14;
/** Above this many differing keys, a name uses all of them (no subset search, T22-004). */
const MAX_SUBSET_KEYS = 16;

const NO_UNIT: Unit = { kind: 'none' };
const counts = new Intl.NumberFormat('en-GB');
/** A count, en-GB grouped (`1,000`). */
const count = (n: number): string => counts.format(n);

function codeUnitOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The bar cap for a category extent: min(200, ⌊extent / 14⌋); 0 without an extent. */
export function barCap(plotExtentCss: number): number {
  if (!(plotExtentCss > 0)) return 0;
  return Math.min(BAR_CAP, Math.floor(plotExtentCss / BAND_PX));
}

/**
 * Series with the same key combined into one (T22-003), in first-seen key order: `duplicates` is
 * Σ(size − 1) and `conflicts` the sum of each group's `mergeKey` conflicts. A key with one series
 * keeps that series as it is.
 */
export function mergeDuplicates(
  series: readonly SeriesFrame[],
  source: 'instant' | 'range',
): { series: SeriesFrame[]; duplicates: number; conflicts: number } {
  const byKey = new Map<string, SeriesFrame[]>();
  for (const s of series) {
    const list = byKey.get(s.key);
    if (list === undefined) byKey.set(s.key, [s]);
    else list.push(s);
  }
  const out: SeriesFrame[] = [];
  let duplicates = 0;
  let conflicts = 0;
  for (const [key, list] of byKey) {
    const first = list[0];
    if (first === undefined) continue;
    if (list.length === 1) {
      out.push(first);
      continue;
    }
    duplicates += list.length - 1;
    const m = mergeKey(list, source);
    conflicts += m.conflicts;
    out.push({
      key,
      labels: first.labels,
      timestamps: Float64Array.from(m.timestamps),
      values: Float64Array.from(m.values),
    });
  }
  return { series: out, duplicates, conflicts };
}

/**
 * `r` over the finite samples of `s` (T22-003): the last or first finite sample, the mean, min,
 * max or sum, or the number of finite samples. With no finite sample: NaN (`count`: 0).
 */
export function reduceSeries(s: SeriesFrame, r: Reducer): number {
  let n = 0;
  let first = NaN;
  let last = NaN;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const v of s.values) {
    if (!Number.isFinite(v)) continue;
    if (n === 0) first = v;
    last = v;
    n += 1;
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (r === 'count') return n;
  if (n === 0) return NaN;
  switch (r) {
    case 'last':
      return last;
    case 'first':
      return first;
    case 'mean':
      return sum / n;
    case 'min':
      return min;
    case 'max':
      return max;
    case 'sum':
      return sum;
  }
}

/**
 * The effective label (T22-005): `categoryBy` when set; else the one label key, `__name__`
 * included, whose value varies across the series (absence counts as a value); null with fewer
 * than 2 series, or when no key or several keys vary.
 */
export function effectiveLabel(series: readonly SeriesFrame[], categoryBy: string): string | null {
  if (categoryBy !== '') return categoryBy;
  if (series.length < 2) return null;
  const keys = new Set<string>();
  for (const s of series) for (const k of Object.keys(s.labels)) keys.add(k);
  let found: string | null = null;
  for (const k of keys) {
    const first = series[0]?.labels[k];
    if (series.every((s) => s.labels[k] === first)) continue;
    if (found !== null) return null;
    found = k;
  }
  return found;
}

/**
 * A raw category value as a name: `JSON.stringify` when it could read as a marker — `other`, a
 * ` (<digits>)` ending, a leading `"` or a control character (T22-004 final pass (1)).
 */
function shownRaw(v: string): string {
  const reserved = v === 'other' || / \(\d+\)$/.test(v) || v.startsWith('"') || /\p{Cc}/u.test(v);
  return reserved ? JSON.stringify(v) : v;
}

/** `k="v"` (quoted as `seriesName` quotes) or `k absent` (T22-004). */
export function part(labels: Labels, k: string): string {
  const v = labels[k];
  return v === undefined ? `${k} absent` : `${k}=${quoted(v)}`;
}

/** The subsets of `items` by size 1…n, each size in lexicographic order, until `found` is true. */
function firstSubset(
  items: readonly string[],
  found: (s: readonly string[]) => boolean,
): readonly string[] | null {
  const pick: string[] = [];
  const walk = (from: number, size: number): boolean => {
    if (pick.length === size) return found(pick);
    for (let i = from; i <= items.length - (size - pick.length); i++) {
      pick.push(items[i] ?? '');
      if (walk(i + 1, size)) return true;
      pick.pop();
    }
    return false;
  };
  for (let size = 1; size <= items.length; size++) if (walk(0, size)) return pick;
  return null;
}

/**
 * The label keys that tell `x` apart from every other member of its group (T22-004): D = the
 * sorted keys on which x differs from at least one other; the first subset of D, breadth-first,
 * whose values set x apart (D always does); D itself when |D| > 16.
 */
export function disambiguator(x: Labels, others: readonly Labels[]): readonly string[] {
  const keys = new Set<string>();
  for (const l of [x, ...others]) for (const k of Object.keys(l)) keys.add(k);
  const d = [...keys].filter((k) => others.some((o) => o[k] !== x[k])).sort(codeUnitOrder);
  if (d.length > MAX_SUBSET_KEYS) return d;
  const s = firstSubset(d, (s) => others.every((o) => s.some((k) => o[k] !== x[k])));
  return s === null ? d : [...s];
}

/**
 * Display names (T22-004, T22-005), over every row before the cap. The base is the raw value of
 * `label` when it is non-empty (quoted when it could read as a marker), else `seriesName(labels)`;
 * rows that share a base get ` · ` and the parts of their distinguishing keys (`k="v"` or
 * `k absent`); names still equal, counting `aggregates`, get ` (1)`, ` (2)`, … in key order.
 * Aggregates are never suffixed.
 */
export function markNames(
  rows: readonly { key: string; labels: Labels }[],
  label: string | null,
  aggregates: readonly string[] = [],
): string[] {
  const groups = <T>(list: readonly T[]): Map<T, number[]> => {
    const m = new Map<T, number[]>();
    list.forEach((x, i) => {
      const g = m.get(x);
      if (g === undefined) m.set(x, [i]);
      else g.push(i);
    });
    return m;
  };
  const bases = rows.map((r) => {
    const raw = label === null ? undefined : r.labels[label];
    return raw !== undefined && raw !== '' ? shownRaw(raw) : seriesName(r.labels);
  });
  const names = [...bases];
  for (const [base, group] of groups(bases)) {
    if (group.length < 2) continue;
    for (const i of group) {
      const x = rows[i]?.labels ?? {};
      const others = group.filter((j) => j !== i).map((j) => rows[j]?.labels ?? {});
      const parts = disambiguator(x, others).map((k) => part(x, k));
      names[i] = parts.length === 0 ? base : `${base} · ${parts.join(' · ')}`;
    }
  }
  const reserved = new Set(aggregates);
  for (const [name, group] of groups([...names])) {
    if (group.length < 2 && !reserved.has(name)) continue;
    group
      .sort((a, b) => codeUnitOrder(rows[a]?.key ?? '', rows[b]?.key ?? ''))
      .forEach((i, n) => {
        names[i] = `${name} (${String(n + 1)})`;
      });
  }
  return names;
}

export interface CategoryResult {
  /** Sorted; every row before the cap. */
  readonly rows: CategoryRow[];
  readonly label: string | null;
  readonly duplicates: number;
  readonly conflicts: number;
  /** The baseline run's merge counts; null without a baseline run. */
  readonly baseline: { readonly duplicates: number; readonly conflicts: number } | null;
}

/** The merged series of a result and a value each (instant: the sample; range: `reducer`). */
function reduced(
  r: ExploreResult,
  reducer: Reducer,
): { series: SeriesFrame[]; values: number[]; duplicates: number; conflicts: number } {
  if (r.kind === 'scalar') {
    const s: SeriesFrame = {
      key: SCALAR_KEY,
      labels: {},
      timestamps: new Float64Array([r.scalar.timestampMs]),
      values: new Float64Array([r.scalar.value]),
    };
    return { series: [s], values: [r.scalar.value], duplicates: 0, conflicts: 0 };
  }
  if (r.kind !== 'series') return { series: [], values: [], duplicates: 0, conflicts: 0 };
  const m = mergeDuplicates(r.series, r.source);
  const values = m.series.map((s) =>
    r.source === 'instant' ? (s.values[s.values.length - 1] ?? NaN) : reduceSeries(s, reducer),
  );
  return { ...m, values };
}

/** By value (`dir` 1 ascending, −1 descending), NaN last; ties by name, then key. */
function byValue(dir: 1 | -1): (a: Mark, b: Mark) => number {
  return (a, b) => {
    const an = Number.isNaN(a.value);
    const bn = Number.isNaN(b.value);
    if (an !== bn) return an ? 1 : -1;
    if (!an && a.value !== b.value) return a.value < b.value ? -dir : dir;
    return codeUnitOrder(a.name, b.name) || codeUnitOrder(a.key, b.key);
  };
}

const SORTS: Readonly<Record<Exclude<Sort, 'none'>, (a: Mark, b: Mark) => number>> = {
  valueDesc: byValue(-1),
  valueAsc: byValue(1),
  label: (a, b) => codeUnitOrder(a.name, b.name) || codeUnitOrder(a.key, b.key),
};

/**
 * The categorical rows of `r` (plan §4.2): duplicates merged in `r` and `base`; one mark per key,
 * with its value, name, state (`stateOf`) and the base run's value for the same key (else null);
 * sorted by `o.sort` (`none`: the result's order). A scalar is one row keyed `SCALAR_KEY`.
 */
export function categoryRows(
  r: ExploreResult,
  base: ExploreResult | null,
  o: { reducer: Reducer; categoryBy: string; sort: Sort; thresholds: Thresholds | null },
): CategoryResult {
  const cur = reduced(r, o.reducer);
  const prev = base === null ? null : reduced(base, o.reducer);
  const baseByKey = new Map<string, number>();
  if (prev !== null) prev.series.forEach((s, i) => baseByKey.set(s.key, prev.values[i] ?? NaN));
  const label = effectiveLabel(cur.series, o.categoryBy);
  const names = markNames(cur.series, label);
  const rows: CategoryRow[] = cur.series.map((s, i) => {
    const value = cur.values[i] ?? NaN;
    return {
      key: s.key,
      labels: s.labels,
      name: names[i] ?? '',
      value,
      state: stateOf(o.thresholds, value),
      baseline: baseByKey.get(s.key) ?? null,
      anomaly: null,
      members: null,
    };
  });
  if (o.sort !== 'none') rows.sort(SORTS[o.sort]);
  return {
    rows,
    label,
    duplicates: cur.duplicates,
    conflicts: cur.conflicts,
    baseline: prev === null ? null : { duplicates: prev.duplicates, conflicts: prev.conflicts },
  };
}

function isNonOk(s: State | null): s is ThresholdState {
  return s === 'watch' || s === 'degraded' || s === 'failing';
}

/** The worst non-OK state of `marks` by `SEVERITY`; null when none is non-OK. */
function worstOf(marks: readonly Mark[]): ThresholdState | null {
  let worst: ThresholdState | null = null;
  for (const m of marks)
    if (isNonOk(m.state) && (worst === null || SEVERITY[m.state] > SEVERITY[worst]))
      worst = m.state;
  return worst;
}

export interface Capped<M extends Mark> {
  /** In sort order. */
  readonly drawn: M[];
  readonly kept: { readonly min: boolean; readonly max: boolean; readonly worst: number };
}

const NOTHING_KEPT = Object.freeze({ min: false, max: false, worst: 0 });

/**
 * The marks drawn under `cap` (T22-006): all when they fit; none for cap ≤ 0; else, in this order,
 * the max finite row, the min finite row (the first in sort order on a tie), rows in the worst
 * non-OK state up to max(1, ⌊cap/10⌋), then the rest in sort order. Drawn rows keep the sort
 * order; `kept.worst` is the number of drawn worst-state rows.
 */
export function capMarks<M extends Mark>(sorted: readonly M[], cap: number): Capped<M> {
  if (sorted.length <= cap) return { drawn: [...sorted], kept: NOTHING_KEPT };
  if (cap <= 0) return { drawn: [], kept: NOTHING_KEPT };
  let maxAt = -1;
  let minAt = -1;
  sorted.forEach((m, i) => {
    if (!Number.isFinite(m.value)) return;
    if (maxAt < 0 || m.value > (sorted[maxAt]?.value ?? NaN)) maxAt = i;
    if (minAt < 0 || m.value < (sorted[minAt]?.value ?? NaN)) minAt = i;
  });
  const chosen = new Set<number>();
  let keptMax = false;
  let keptMin = false;
  if (maxAt >= 0) {
    chosen.add(maxAt);
    keptMax = true;
  }
  if (minAt >= 0 && (chosen.has(minAt) || chosen.size < cap)) {
    chosen.add(minAt);
    keptMin = true;
  }
  const worst = worstOf(sorted);
  if (worst !== null) {
    const limit = Math.max(1, Math.floor(cap / 10));
    let added = 0;
    for (let i = 0; i < sorted.length && added < limit && chosen.size < cap; i++) {
      if (sorted[i]?.state !== worst || chosen.has(i)) continue;
      chosen.add(i);
      added += 1;
    }
  }
  for (let i = 0; i < sorted.length && chosen.size < cap; i++) chosen.add(i);
  const drawn = sorted.filter((_, i) => chosen.has(i));
  const keptWorst = worst === null ? 0 : drawn.filter((m) => m.state === worst).length;
  return { drawn, kept: { min: keptMin, max: keptMax, worst: keptWorst } };
}

/** The keys a drawn row stands for: its own, and its members' (an aggregate). */
function drawnKeys(drawn: readonly Mark[]): Set<string> {
  const keys = new Set<string>();
  for (const m of drawn) {
    keys.add(m.key);
    const members = 'members' in m ? (m as CategoryRow).members : null;
    if (members !== null) for (const x of members) keys.add(x.key);
  }
  return keys;
}

/**
 * The frame's coverage (T22-006): the pre-cap total, what was drawn and kept, the worst state over
 * all rows (null when none is non-OK) and the number of rows in it that are not drawn.
 */
export function categoryCoverage(a: {
  all: readonly Mark[];
  capped: Capped<Mark>;
  query: Completeness;
  baseline: Completeness | null;
  outside: number;
  duplicates: number;
  conflicts: number;
}): Coverage {
  const worst = worstOf(a.all);
  const shown = drawnKeys(a.capped.drawn);
  const omittedWorst =
    worst === null ? 0 : a.all.filter((m) => m.state === worst && !shown.has(m.key)).length;
  return {
    total: a.all.length,
    drawn: a.capped.drawn.length,
    keptMin: a.capped.kept.min,
    keptMax: a.capped.kept.max,
    keptWorst: a.capped.kept.worst,
    omittedWorst,
    worstState: worst,
    outside: a.outside,
    duplicates: a.duplicates,
    conflicts: a.conflicts,
    query: a.query,
    baseline: a.baseline,
  };
}

const clocks = new Map<string, Intl.DateTimeFormat>();

/** `HH:mm:ss` in `tz`. */
export function clockText(ms: number, tz: string): string {
  let f = clocks.get(tz);
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      timeZone: tz,
    });
    clocks.set(tz, f);
  }
  return f.format(ms);
}

/** The leading part of the list widgets (T24-024, T24-033), or null. */
function unknownText(u: Coverage['unknown']): string | null {
  if (u === undefined) return null;
  switch (u.reason) {
    case 'oldServer':
      return t('coverage.unknown');
    case 'tagsStale':
      return t(u.count === 1 ? 'coverage.tagsStaleOne' : 'coverage.tagsStale', {
        n: count(u.count),
      });
    case 'paged':
      return t('coverage.paged', { n: count(u.pages) });
  }
}

/**
 * The geomap parts (T22-006, T24 §4.11), in order with zeros omitted: `k not placed`,
 * `k ambiguous`, `locations unavailable`, `k outside the map`, and
 * `k without a usable value (a missing, b infinite, c out of range)`.
 */
function geoParts(g: Coverage['geo']): string[] {
  if (g === undefined) return [];
  const parts: string[] = [];
  if (g.notPlaced > 0) parts.push(t('coverage.geo.notPlaced', { n: count(g.notPlaced) }));
  if (g.ambiguous > 0) parts.push(t('coverage.geo.ambiguous', { n: count(g.ambiguous) }));
  if (g.locationsUnavailable > 0) parts.push(t('coverage.geo.locationsUnavailable'));
  if (g.outsideMap > 0) parts.push(t('coverage.geo.outsideMap', { n: count(g.outsideMap) }));
  const unusable = g.noValue + g.infinite + g.outOfRange;
  if (unusable > 0) {
    const why: string[] = [];
    if (g.noValue > 0) why.push(t('coverage.geo.missing', { n: count(g.noValue) }));
    if (g.infinite > 0) why.push(t('coverage.geo.infinite', { n: count(g.infinite) }));
    if (g.outOfRange > 0) why.push(t('coverage.geo.outOfRange', { n: count(g.outOfRange) }));
    parts.push(t('coverage.geo.noValue', { n: count(unusable), parts: why.join(', ') }));
  }
  return parts;
}

/**
 * The map area parts (T22-006, T24-098), after every other part, zeros omitted:
 * `k outside the map area`, `k without a location`, `map area not applied to k (locations
 * unavailable)`.
 */
function areaParts(a: Coverage['area']): string[] {
  if (a === undefined) return [];
  const parts: string[] = [];
  if (a.outside > 0) parts.push(t('coverage.area.outside', { n: count(a.outside) }));
  if (a.unlocated > 0) parts.push(t('coverage.area.unlocated', { n: count(a.unlocated) }));
  if (a.unapplied > 0) parts.push(t('coverage.area.unapplied', { n: count(a.unapplied) }));
  return parts;
}

/** The cap text (T22-006 (4)): `showing X of N`, `; kept …` and `; J <state> not shown`. */
function capText(c: Coverage): string {
  let text = t('coverage.showing', { x: count(c.drawn), n: count(c.total) });
  const kept: string[] = [];
  if (c.keptMin) kept.push('min');
  if (c.keptMax) kept.push('max');
  if (c.keptWorst > 0 && c.worstState !== null) kept.push(`${count(c.keptWorst)} ${c.worstState}`);
  if (kept.length > 0) text += t('coverage.kept', { list: kept.join(', ') });
  if (c.omittedWorst > 0 && c.worstState !== null) {
    text += t('coverage.notShown', { n: count(c.omittedWorst), state: c.worstState });
  }
  return text;
}

/**
 * The VIZ-027 meter text (T22-006): the applicable parts joined by ` · `, or `100 %` with none —
 * the list widgets' leading part, `truncated`, `limited (N warnings)`, the geomap counts, the
 * baseline run's
 * truncation or warnings, the cap text, the values outside the fixed range, the duplicate merge,
 * and the list widgets' `stale (HH:mm:ss)` in `timeZone` (default the browser's). Counts are en-GB
 * grouped.
 */
export function coverageText(c: Coverage, timeZone: string = browserTimeZone()): string {
  const parts: string[] = [];
  const unknown = unknownText(c.unknown);
  if (unknown !== null) parts.push(unknown);
  if (c.query.truncated) parts.push(t('coverage.truncated'));
  const w = c.query.warnings.length;
  if (w > 0) parts.push(t(w === 1 ? 'coverage.limitedOne' : 'coverage.limited', { n: count(w) }));
  parts.push(...geoParts(c.geo));
  const b = c.baseline;
  if (b !== null && b.truncated) parts.push(t('coverage.baselineTruncated'));
  else if (b !== null && b.warnings.length > 0) {
    const bw = b.warnings.length;
    parts.push(
      t(bw === 1 ? 'coverage.baselineLimitedOne' : 'coverage.baselineLimited', { n: count(bw) }),
    );
  }
  if (c.drawn < c.total) parts.push(capText(c));
  if (c.outside > 0) {
    parts.push(
      t(c.outside === 1 ? 'coverage.outsideOne' : 'coverage.outside', { n: count(c.outside) }),
    );
  }
  if (c.duplicates > 0) {
    let text = t('coverage.duplicates', { n: count(c.duplicates) });
    if (c.conflicts > 0) text += t('coverage.conflicts', { n: count(c.conflicts) });
    parts.push(text);
  }
  if (c.staleAtMs !== undefined && c.staleAtMs !== null) {
    parts.push(t('coverage.stale', { time: clockText(c.staleAtMs, timeZone) }));
  }
  parts.push(...areaParts(c.area));
  return parts.length === 0 ? t('coverage.complete') : parts.join(' · ');
}

/** The first finite mark with the least (`dir` 1) or the greatest (−1) value; null when none. */
function extreme(all: readonly Mark[], dir: 1 | -1): Mark | null {
  let best: Mark | null = null;
  for (const m of all)
    if (Number.isFinite(m.value) && (best === null || (m.value - best.value) * dir < 0)) best = m;
  return best;
}

/** The `tooSmall` notice (T22-006): `too small: N bars (min <name> <v>, max <name> <v>[, K <state>])`. */
export function tooSmallText(all: readonly Mark[], unit: Unit): string {
  const parts: string[] = [];
  const min = extreme(all, 1);
  const max = extreme(all, -1);
  if (min !== null) {
    parts.push(t('category.min', { name: min.name, value: formatValue(min.value, unit) }));
  }
  if (max !== null) {
    parts.push(t('category.max', { name: max.name, value: formatValue(max.value, unit) }));
  }
  const worst = worstOf(all);
  if (worst !== null) parts.push(`${count(all.filter((m) => m.state === worst).length)} ${worst}`);
  const n = count(all.length);
  return parts.length === 0
    ? t('category.tooSmall', { n })
    : t('category.tooSmallDetail', { n, parts: parts.join(', ') });
}

/** The drawn finite values outside `range`; 0 without a range. */
export function outsideCount(drawn: readonly Mark[], range: ValueRange | null): number {
  if (range === null) return 0;
  return drawn.filter(
    (m) => Number.isFinite(m.value) && (m.value < range.min || m.value > range.max),
  ).length;
}

/**
 * The value range of `options.min`/`max` over the auto range (T22 §6.1, ADR-0022): an absent bound
 * takes its auto value, except that only `min` with min ≥ auto max gives max = min + span, and only
 * `max` with max ≤ auto min gives min = max − span (span = the auto span, or 1 when it is 0).
 */
export function resolveBounds(
  min: number | undefined,
  max: number | undefined,
  auto: ValueRange,
): ValueRange {
  const span = auto.max - auto.min || 1;
  if (min !== undefined && max !== undefined) return { min, max };
  if (min !== undefined) return { min, max: min >= auto.max ? min + span : auto.max };
  if (max !== undefined) return { min: max <= auto.min ? max - span : auto.min, max };
  return auto;
}

export type FilterPair =
  | { readonly key: string; readonly value: string }
  | { readonly reason: 'noLabel' }
  | { readonly reason: 'missing'; readonly label: string };

/** The board filter a click applies (T22-007): the effective label's pair, or why there is none. */
export function filterPair(m: Mark, label: string | null): FilterPair {
  if (label === null) return { reason: 'noLabel' };
  const value = m.labels[label];
  if (value === undefined || value === '') return { reason: 'missing', label };
  return { key: label, value };
}

/** The tooltip of a click that cannot filter (T22-007). */
export function filterBlockText(p: Exclude<FilterPair, { key: string }>): string {
  return p.reason === 'noLabel'
    ? t('category.filter.noLabel')
    : t('category.filter.missing', { label: p.label });
}

/**
 * The baseline delta (T22-012): `▲`, `▼` or `=`, a space, `formatValue(|d|)` and ` %`, with
 * d = (v − b)/|b| × 100; null when b is null, 0 or not finite, or v is not finite.
 */
export function deltaText(v: number, b: number | null): string | null {
  if (b === null || b === 0 || !Number.isFinite(b) || !Number.isFinite(v)) return null;
  const d = ((v - b) / Math.abs(b)) * 100;
  const glyph = d > 0 ? '▲' : d < 0 ? '▼' : '=';
  return `${glyph} ${formatValue(Math.abs(d), NO_UNIT)} %`;
}

/** The kinds with a categorical table; I2 adds `stat`, I3 `pie`; #234 the geomap (T24 §4.14). */
export type TableKind = 'barchart' | 'geomap';

/**
 * The kit table's rows (T22-013; plan #216 Part 2a §3.3): the columns, then one row per item with
 * its key, whether it is drawn (shown) and its cells. `PanelRows` and the list widgets' tables are
 * table views.
 */
export interface TableView {
  readonly columns: readonly string[];
  readonly rows: readonly {
    readonly key: string;
    readonly drawn: boolean;
    readonly cells: readonly string[];
  }[];
}

export interface PanelRows extends TableView {
  readonly rows: readonly {
    /** The mark's key. */
    readonly key: string;
    readonly mark: Mark;
    readonly drawn: boolean;
    readonly shownAs: string;
    readonly cells: readonly string[];
  }[];
}

/** The table and CSV columns of each kind (T22-013; the geomap's, T24 §4.14). */
export const TABLE_COLUMNS: Readonly<Record<TableKind, readonly string[]>> = Object.freeze({
  barchart: Object.freeze(['name', 'value', 'baseline', 'state', 'drawn', 'shown as']),
  geomap: Object.freeze([
    'name',
    'key',
    'value',
    'value_status',
    'state',
    'location_status',
    'location_detail',
    'source',
    'code',
    'provider',
    'place',
    'lat',
    'lon',
    'group',
    'group_member',
    'draw_status',
  ]),
});

const numberCell = (v: number | null): string => (v === null || Number.isNaN(v) ? '' : String(v));

/**
 * The table view's rows (T22-013): one per mark of `all` (real marks only), in order. `drawn` may
 * hold aggregates; a member of a drawn aggregate is drawn and shown as the aggregate's name, a
 * drawn key as its own name; any other row is not drawn and `shown as` is empty. The cells hold
 * numbers as `String(v)` (NaN or null empty) and states by name, so they do not depend on
 * `unit`, which the view formats with (Part 3).
 */
export function panelRows(
  // The geomap's rows are `vis/geo/rows.ts`'s (`geoTable`).
  kind: Exclude<TableKind, 'geomap'>,
  all: readonly Mark[],
  drawn: readonly CategoryRow[],
  // The view's unit; the cells are raw numbers (T22-013), so this kind needs none.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  unit: Unit,
): PanelRows {
  const shownAs = new Map<string, string>();
  for (const d of drawn) {
    if (d.members === null) shownAs.set(d.key, d.name);
    else for (const m of d.members) shownAs.set(m.key, d.name);
  }
  const rows = all.map((mark) => {
    const as = shownAs.get(mark.key);
    return {
      key: mark.key,
      mark,
      drawn: as !== undefined,
      shownAs: as ?? '',
      cells: [
        mark.name,
        numberCell(mark.value),
        numberCell(mark.baseline),
        mark.state ?? '',
        as === undefined ? 'no' : 'yes',
        as ?? '',
      ],
    };
  });
  return { columns: TABLE_COLUMNS[kind], rows };
}

/** The CSV of `t` (T22-013): the header, then every row; each cell through `csvCell`; CRLF. */
export function panelCsv(t: TableView): string {
  const line = (cells: readonly string[]): string => `${cells.map(csvCell).join(',')}\r\n`;
  return line(t.columns) + t.rows.map((r) => line(r.cells)).join('');
}

/** The CSV file name: the title with `[^A-Za-z0-9-_]` as `_`, plus `.csv` (untitled: `panel.csv`). */
export function csvFileName(title: string): string {
  return title === '' ? 'panel.csv' : `${title.replace(/[^A-Za-z0-9_-]/gu, '_')}.csv`;
}

/** watch 1, degraded 2, failing 3 (`SEVERITY`); ok 0; unknown or none −1. */
function rank(s: State | null): number {
  if (s === 'ok') return 0;
  return isNonOk(s) ? SEVERITY[s] : -1;
}

/**
 * The focus mark (T22-014) among the finite marks: the worst state, else the highest value; ties
 * go to the higher value, then the lower key.
 */
export function focusOf<M extends Mark>(all: readonly M[]): M | null {
  let best: M | null = null;
  for (const m of all) {
    if (!Number.isFinite(m.value)) continue;
    if (best === null) {
      best = m;
      continue;
    }
    const d = rank(m.state) - rank(best.state);
    const higher = m.value > best.value || (m.value === best.value && m.key < best.key);
    if (d > 0 || (d === 0 && higher)) best = m;
  }
  return best;
}

/** The largest |Δ| between consecutive finite samples (the first on ties); null below 2 samples. */
export function largestChange(s: SeriesFrame): { from: number; to: number; atMs: number } | null {
  let prev: number | null = null;
  let best: { from: number; to: number; atMs: number } | null = null;
  for (let i = 0; i < s.values.length; i++) {
    const v = s.values[i] ?? NaN;
    if (!Number.isFinite(v)) continue;
    if (prev !== null && (best === null || Math.abs(v - prev) > Math.abs(best.to - best.from))) {
      best = { from: prev, to: v, atMs: s.timestamps[i] ?? NaN };
    }
    prev = v;
  }
  return best;
}

/**
 * The summary facts (T22-014) over every pre-cap mark and the merged `r`: `current` the focus
 * mark's value and name; `change` the largest step of its series (range results only); `extent`
 * the min and max finite mark values; `baselineRatio` current ÷ its baseline when both are finite,
 * the baseline is not 0 and the baseline run is complete. With no finite mark all four are null.
 */
export function summaryFacts(
  kind: Exclude<TableKind, 'geomap'>,
  title: string,
  r: ExploreResult,
  all: readonly Mark[],
  unit: Unit,
  baseline: Completeness | null,
): SummaryFacts {
  // One kind today (barchart); I2's stat focuses on the single tile first.
  const focus = focusOf(all);
  if (focus === null) {
    return { subject: title, current: null, change: null, extent: null, baselineRatio: null };
  }
  let change: SummaryFacts['change'] = null;
  if (r.kind === 'series' && r.source === 'range') {
    const s = mergeDuplicates(r.series, 'range').series.find((x) => x.key === focus.key);
    const c = s === undefined ? null : largestChange(s);
    if (c !== null) {
      const from = formatValue(c.from, unit);
      change = { series: focus.name, from, to: formatValue(c.to, unit), atMs: c.atMs };
    }
  }
  let min = Infinity;
  let max = -Infinity;
  for (const m of all) {
    if (!Number.isFinite(m.value)) continue;
    if (m.value < min) min = m.value;
    if (m.value > max) max = m.value;
  }
  const b = focus.baseline;
  const complete = baseline !== null && !baseline.truncated && baseline.warnings.length === 0;
  const ratio = complete && b !== null && Number.isFinite(b) && b !== 0 ? focus.value / b : null;
  return {
    subject: title,
    current: { text: formatValue(focus.value, unit), series: focus.name },
    change,
    extent: { min, max },
    baselineRatio: ratio,
  };
}
