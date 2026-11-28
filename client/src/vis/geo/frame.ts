/**
 * The geomap's rows (T24-089, T24-090, T24 §4.11, §5.15; plan #234 Part 1 §3.1, §4.1, §4.2): one
 * `GeoRow` per series with its value, value status, state, location, draw status and group; the
 * groups with their final labels, patterns and colours; the coverage counted before the cap; and
 * the validator of a row set. Pure and synchronous: the same series in any order give the same
 * row set. Strings compare by UTF-16 code units (JavaScript `<`).
 */
import type { Completeness } from '../../data/decode';
import {
  type Coverage,
  type FrameDataIssue,
  type GeoCoverageCount,
  type Labels,
  type Mark,
  type Reducer,
  type SeriesFrame,
  type State,
} from '../../data/frames';
import type { GeoView, ThresholdState } from '../../engine/api';
import { seriesColourIndex } from '../../engine/canvas2d/seriesColour';
import { CATEGORY_PATTERNS, HEALTH_PATTERN, OTHER_PATTERN } from '../../engine/patterns';
import { t } from '../../i18n/t';
import { capMarks, disambiguator, mergeDuplicates, part, reduceSeries } from '../reduce';
import { displayName } from '../legendFormat';
import { SEVERITY, stateOf, type Thresholds } from '../thresholds';
import { locate, type LocationOption, type LocationResult } from './locate';
import type { Basemap, Gazetteer } from './types';

export type ValueStatus = 'ok' | 'noValue' | 'infinite' | 'outOfRange';
export type DrawStatus = 'shown' | 'notPlaced' | 'outsideMap' | 'excluded' | 'capped';
export type GroupId =
  | { readonly series: string }
  | { readonly present: true; readonly value: string }
  | { readonly present: false }
  | { readonly other: true };

export interface GeoRow {
  readonly key: string;
  readonly labels: Labels;
  readonly name: string;
  readonly value: number;
  readonly valueStatus: ValueStatus;
  readonly state: State | null;
  readonly location: LocationResult;
  readonly draw: DrawStatus;
  /** The drawn group: an own group, or the aggregate (7) for its members. */
  readonly group: number;
  /** The row's own id, never `{other}`. */
  readonly groupId: GroupId;
}

export interface GeoGroup {
  readonly id: GroupId;
  readonly label: string;
  readonly pattern: string;
  /** The `series-N` index; null for the aggregate (`category-other`). */
  readonly colourIndex: number | null;
  /** The aggregate's member ids, in first-appearance order; null for an own group. */
  readonly members: readonly GroupId[] | null;
  /** Parallel to `members`: the members' final labels. */
  readonly memberLabels: readonly string[] | null;
}

export interface GeoRowSet {
  /** By key (UTF-16 code units). */
  readonly rows: readonly GeoRow[];
  readonly groups: readonly GeoGroup[];
  readonly coverage: Coverage;
  /** The `groupBy` label key; null without one. */
  readonly groupBy: string | null;
}

export interface GeoFrame extends GeoRowSet {
  readonly seq: number;
  /** The indices of the `shown` rows. */
  readonly shown: Uint32Array;
  readonly basemap: Basemap;
}

export interface GeomapOptions {
  readonly location: LocationOption;
  readonly reducer: Reducer;
  readonly size: { readonly by: 'value' | 'fixed'; readonly min: number; readonly max: number };
  readonly colour: 'group' | 'state';
  readonly groupBy: string | null;
  readonly symbol: 'circle' | 'square' | 'triangle' | 'diamond';
  readonly labels: 'auto' | 'none';
  readonly cluster: boolean;
  readonly wheelZoom: boolean;
  readonly view: GeoView | null;
}

/** The most drawn rows (T22-006 above 5 000 drawable rows). */
export const GEO_CAP = 5000;
/** The Web Mercator latitude limit: a placed row beyond it is `outsideMap`. */
export const MAX_LAT = 85.0511;
/** With this many group ids or more, ids 7 and later join the aggregate (T24-090). */
const MAX_GROUPS = 8;
const OWN_GROUPS = MAX_GROUPS - 1;

/** The magnitude bounds of a usable non-zero value (T21-012). */
const MIN_ABS = 1e-290;
const MAX_ABS = 1e290;

/** T21-012: NaN `noValue`; ±Infinity `infinite`; v ≠ 0 with |v| < 1e−290 or > 1e290 `outOfRange`. */
export function valueStatusOf(v: number): ValueStatus {
  if (Number.isNaN(v)) return 'noValue';
  if (!Number.isFinite(v)) return 'infinite';
  const a = Math.abs(v);
  return v !== 0 && (a < MIN_ABS || a > MAX_ABS) ? 'outOfRange' : 'ok';
}

function codeUnitOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The state a row must have (T24-089 `state`): null without thresholds; `unknown` for a non-ok value. */
function stateFor(th: Thresholds | null, value: number, status: ValueStatus): State | null {
  if (th === null) return null;
  return status === 'ok' ? stateOf(th, value) : 'unknown';
}

/** The row's own group id: its series without `groupBy`, else the label's presence and value. */
function ownId(key: string, labels: Labels, groupBy: string | null): GroupId {
  if (groupBy === null) return { series: key };
  const v = labels[groupBy];
  return v === undefined ? { present: false } : { present: true, value: v };
}

const idKey = (id: GroupId): string => JSON.stringify(id);

/** A present `groupBy` value as a label: plain, or `JSON.stringify` when it could read as a marker. */
function presentLabel(v: string, groupBy: string): string {
  const reserved =
    v.startsWith('"') ||
    v === 'other' ||
    v === t('geo.group.absent', { label: groupBy }) ||
    / \(\d+\)$/.test(v) ||
    /\p{Cc}/u.test(v);
  return reserved ? JSON.stringify(v) : v;
}

/**
 * The T24-090 final pass over the legend labels (`entries` in their order; `aggregate` the index
 * of the aggregate's entry, or −1): equal bases (the aggregate apart) get the T22-004 disambiguator
 * parts (` · k="v"`, ` · k absent`); a label still shared, or equal to the aggregate's, gets
 * ` (n)`, n from 1 in key order, skipping labels in use. The aggregate is never suffixed.
 */
export function finalLabels(
  entries: readonly { key: string; labels: Labels; base: string }[],
  aggregate: number,
): string[] {
  const byLabel = (labels: readonly string[]): Map<string, number[]> => {
    const m = new Map<string, number[]>();
    labels.forEach((l, i) => {
      if (i === aggregate) return;
      const g = m.get(l);
      if (g === undefined) m.set(l, [i]);
      else g.push(i);
    });
    return m;
  };
  const out = entries.map((e) => e.base);
  for (const [base, group] of byLabel(out)) {
    if (group.length < 2) continue;
    for (const i of group) {
      const x = entries[i]?.labels ?? {};
      const others = group.filter((j) => j !== i).map((j) => entries[j]?.labels ?? {});
      const parts = disambiguator(x, others).map((k) => part(x, k));
      out[i] = parts.length === 0 ? base : `${base} · ${parts.join(' · ')}`;
    }
  }
  const aggregateLabel = aggregate >= 0 ? (out[aggregate] ?? null) : null;
  const used = new Set(out);
  for (const [label, group] of byLabel([...out])) {
    if (group.length < 2 && label !== aggregateLabel) continue;
    group.sort((a, b) => codeUnitOrder(entries[a]?.key ?? '', entries[b]?.key ?? ''));
    let n = 1;
    for (const i of group) {
      while (used.has(`${label} (${String(n)})`)) n += 1;
      const next = `${label} (${String(n)})`;
      out[i] = next;
      used.add(next);
      n += 1;
    }
  }
  return out;
}

/** What a row carries before the draw status and the groups (§4.1 steps 1–2). */
interface Base {
  readonly key: string;
  readonly labels: Labels;
  readonly name: string;
  readonly value: number;
  readonly valueStatus: ValueStatus;
  readonly state: State | null;
  readonly location: LocationResult;
}

const asMark = (r: Base): Mark => ({
  key: r.key,
  labels: r.labels,
  name: r.name,
  value: r.value,
  state: r.state,
  baseline: null,
  anomaly: null,
});

function isNonOk(s: State | null): s is ThresholdState {
  return s === 'watch' || s === 'degraded' || s === 'failing';
}

/** The draw statuses of rows in key order (§4.1 step 3) and what the cap kept. */
function drawStatuses(rows: readonly Base[]): {
  draw: DrawStatus[];
  kept: ReturnType<typeof capMarks>['kept'];
} {
  const draw: DrawStatus[] = rows.map((r) => {
    if (r.location.status !== 'placed') return 'notPlaced';
    if (Math.abs(r.location.place.lat) > MAX_LAT) return 'outsideMap';
    return r.valueStatus === 'ok' ? 'shown' : 'excluded';
  });
  const drawable = rows.filter((_, i) => draw[i] === 'shown').map(asMark);
  const capped = capMarks(drawable, GEO_CAP);
  if (capped.drawn.length < drawable.length) {
    const kept = new Set(capped.drawn.map((m) => m.key));
    rows.forEach((r, i) => {
      if (draw[i] === 'shown' && !kept.has(r.key)) draw[i] = 'capped';
    });
  }
  return { draw, kept: capped.kept };
}

/** The coverage of rows with their draw statuses (§4.1 step 6), counted before the cap. */
function coverageOf(
  rows: readonly Base[],
  draw: readonly DrawStatus[],
  kept: ReturnType<typeof capMarks>['kept'],
  merge: { duplicates: number; conflicts: number; query: Completeness },
): Coverage {
  let worst: ThresholdState | null = null;
  const drawable = rows.filter((_, i) => draw[i] === 'shown' || draw[i] === 'capped');
  for (const r of drawable)
    if (isNonOk(r.state) && (worst === null || SEVERITY[r.state] > SEVERITY[worst]))
      worst = r.state;
  const geo: Record<GeoCoverageCount, number> = {
    notPlaced: 0,
    ambiguous: 0,
    locationsUnavailable: 0,
    outsideMap: 0,
    noValue: 0,
    infinite: 0,
    outOfRange: 0,
  };
  let omittedWorst = 0;
  rows.forEach((r, i) => {
    const s = r.location.status;
    if (s === 'ambiguous') geo.ambiguous += 1;
    else if (s === 'gazetteerUnavailable') geo.locationsUnavailable += 1;
    else if (s !== 'placed') geo.notPlaced += 1;
    if (draw[i] === 'outsideMap') geo.outsideMap += 1;
    if (r.valueStatus !== 'ok') geo[r.valueStatus] += 1;
    if (draw[i] === 'capped' && worst !== null && r.state === worst) omittedWorst += 1;
  });
  return {
    total: drawable.length,
    drawn: draw.filter((d) => d === 'shown').length,
    keptMin: kept.min,
    keptMax: kept.max,
    keptWorst: kept.worst,
    omittedWorst,
    worstState: worst,
    outside: 0,
    duplicates: merge.duplicates,
    conflicts: merge.conflicts,
    query: merge.query,
    baseline: null,
    geo,
  };
}

/**
 * The groups of rows in key order (§4.1 steps 4–5): the distinct own ids by first appearance; with
 * 8 or more, ids 7 and later join one aggregate. Returns each row's group and the groups.
 */
function groupsOf(
  rows: readonly Base[],
  ids: readonly GroupId[],
  groupBy: string | null,
): { group: number[]; groups: GeoGroup[] } {
  const first = new Map<string, number>();
  const distinct: { id: GroupId; row: number }[] = [];
  ids.forEach((id, i) => {
    const k = idKey(id);
    if (first.has(k)) return;
    first.set(k, distinct.length);
    distinct.push({ id, row: i });
  });
  const n = distinct.length;
  const aggregated = n >= MAX_GROUPS;
  const group = ids.map((id) => {
    const j = first.get(idKey(id)) ?? 0;
    return aggregated && j >= OWN_GROUPS ? OWN_GROUPS : j;
  });
  // The final pass runs over every group id and the aggregate together.
  const entries = distinct.map(({ id, row }) => {
    const r = rows[row];
    const key = r?.key ?? '';
    if ('series' in id) return { key, labels: r?.labels ?? {}, base: r?.name ?? '' };
    if ('present' in id && id.present && groupBy !== null) {
      return { key, labels: { [groupBy]: id.value }, base: presentLabel(id.value, groupBy) };
    }
    return { key, labels: {}, base: t('geo.group.absent', { label: groupBy ?? '' }) };
  });
  const members = aggregated ? n - OWN_GROUPS : 0;
  const otherLabel = t('geo.group.other', { n: members });
  const labels = finalLabels(
    aggregated ? [...entries, { key: '', labels: {}, base: otherLabel }] : entries,
    aggregated ? n : -1,
  );
  const groups: GeoGroup[] = distinct
    .slice(0, aggregated ? OWN_GROUPS : n)
    .map(({ id, row }, j) => {
      const r = rows[row];
      return {
        id,
        label: labels[j] ?? '',
        pattern: n === 1 ? HEALTH_PATTERN : (CATEGORY_PATTERNS[j] ?? OTHER_PATTERN),
        colourIndex:
          groupBy === null
            ? seriesColourIndex({ key: r?.key ?? '', labels: r?.labels ?? {} })
            : j % MAX_GROUPS,
        members: null,
        memberLabels: null,
      };
    });
  if (aggregated) {
    groups.push({
      id: { other: true },
      label: otherLabel,
      pattern: OTHER_PATTERN,
      colourIndex: null,
      members: distinct.slice(OWN_GROUPS).map((d) => d.id),
      memberLabels: labels.slice(OWN_GROUPS, n),
    });
  }
  return { group, groups };
}

/**
 * The row set of a result (T24-089, T24-090; §4.1): duplicates merged (T22-003), then by key; each
 * series' value (instant: its sample; range: `o.reducer`), value status, state (with `th`),
 * location (`locate` with `o.location` and `g`), draw status (the cap in key order) and group; the
 * groups with their final labels; the coverage before the cap, with the run's completeness `q`.
 */
export function geoRowSet(
  series: readonly SeriesFrame[],
  source: 'instant' | 'range',
  o: GeomapOptions,
  th: Thresholds | null,
  g: Gazetteer | null,
  q: Completeness,
  /** The legend name template (#204): each row's name; null = the full label set. */
  legendFormat: string | null = null,
): GeoRowSet {
  const m = mergeDuplicates(series, source);
  const sorted = [...m.series].sort((a, b) => codeUnitOrder(a.key, b.key));
  const base: Base[] = sorted.map((s) => {
    const value =
      source === 'instant' ? (s.values[s.values.length - 1] ?? NaN) : reduceSeries(s, o.reducer);
    const valueStatus = valueStatusOf(value);
    return {
      key: s.key,
      labels: s.labels,
      name: displayName(s.labels, legendFormat),
      value,
      valueStatus,
      state: stateFor(th, value, valueStatus),
      location: locate(s.labels, o.location, g),
    };
  });
  const { draw, kept } = drawStatuses(base);
  const ids = base.map((r) => ownId(r.key, r.labels, o.groupBy));
  const { group, groups } = groupsOf(base, ids, o.groupBy);
  const rows: GeoRow[] = base.map((r, i) => ({
    ...r,
    draw: draw[i] ?? 'notPlaced',
    group: group[i] ?? 0,
    groupId: ids[i] ?? { series: r.key },
  }));
  const coverage = coverageOf(base, draw, kept, { ...m, query: q });
  return { rows, groups, coverage, groupBy: o.groupBy };
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * The first problem of a row set (T24-089, §4.2), or null, in this order: `order` (keys non-empty,
 * strictly increasing), `value` (the T21-012 status), `state` (null without `th`; else `unknown`
 * for a non-ok value and its threshold state otherwise), `draw` (recomputed with the cap), `group`
 * (indices, ids, patterns, colours and the aggregate's members, T24-090) and `coverage` (every count
 * recounted; the merge counts and the run's completeness are the run's).
 */
export function validateGeoRows(s: GeoRowSet, th: Thresholds | null): FrameDataIssue | null {
  const issue = (detail: Extract<FrameDataIssue, { code: 'geo' }>['detail']): FrameDataIssue => ({
    code: 'geo',
    detail,
  });
  const rows = s.rows;
  for (let i = 0; i < rows.length; i++) {
    const key = rows[i]?.key ?? '';
    if (key === '' || (i > 0 && !((rows[i - 1]?.key ?? '') < key))) return issue('order');
  }
  if (rows.some((r) => r.valueStatus !== valueStatusOf(r.value))) return issue('value');
  if (rows.some((r) => r.state !== stateFor(th, r.value, r.valueStatus))) return issue('state');
  const { draw, kept } = drawStatuses(rows);
  if (rows.some((r, i) => r.draw !== draw[i])) return issue('draw');
  if (groupIssue(s)) return issue('group');
  const want = coverageOf(rows, draw, kept, {
    duplicates: s.coverage.duplicates,
    conflicts: s.coverage.conflicts,
    query: s.coverage.query,
  });
  return same(s.coverage, want) ? null : issue('coverage');
}

/** Whether the groups of `s` break T24-089 `group` (labels are not checked). */
function groupIssue(s: GeoRowSet): boolean {
  if (s.groups.length > MAX_GROUPS) return true;
  if (s.rows.some((r) => 'other' in r.groupId)) return true;
  if (s.rows.some((r) => !same(r.groupId, ownId(r.key, r.labels, s.groupBy)))) return true;
  const want = groupsOf(
    s.rows,
    s.rows.map((r) => r.groupId),
    s.groupBy,
  );
  if (s.rows.some((r, i) => r.group !== want.group[i])) return true;
  if (s.groups.length !== want.groups.length) return true;
  return s.groups.some((g, j) => {
    const w = want.groups[j];
    return (
      w === undefined ||
      !same(g.id, w.id) ||
      g.pattern !== w.pattern ||
      g.colourIndex !== w.colourIndex ||
      !same(g.members, w.members) ||
      (g.memberLabels?.length ?? -1) !== (w.memberLabels?.length ?? -1)
    );
  });
}

/** The frame of a validated row set: `shown` holds the indices of its `shown` rows. */
export function geoFrame(s: GeoRowSet, b: Basemap, seq: number): GeoFrame {
  const shown: number[] = [];
  s.rows.forEach((r, i) => {
    if (r.draw === 'shown') shown.push(i);
  });
  return { ...s, seq, shown: Uint32Array.from(shown), basemap: b };
}
