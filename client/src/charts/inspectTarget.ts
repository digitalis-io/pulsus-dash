/**
 * Inspector targets of the chart kinds (T25 §4.2, T25-002, plan #192 §3): the engine's `HoverItem`
 * of a keyboard row, the `InspectorTarget` an item names, and the selection an inspect writes.
 */
import { bucketEnd, EMPTY_COVERAGE, seriesName, statValue, type SeriesFrame } from '../data/frames';
import type { FrameData, HoverItem, HoverRow, TimeHoverEvent, Unit, VisSpec } from '../engine/api';
import { formatValue } from '../i18n/format';
import { t } from '../i18n/t';
import type { InspectorTarget, Selection } from '../inspector/types';
import type { GeoFrame, GeoRow, GeoRowSet } from '../vis/geo/frame';
import { geoPlace, geoTarget, seedOrdered, worstState } from '../vis/geo/targets';

/** No rows: the target of a geo item on data that is not a geomap's (never drawn). */
const EMPTY_SET: GeoRowSet = Object.freeze({
  rows: [],
  groups: [],
  groupBy: null,
  coverage: EMPTY_COVERAGE,
});

const seriesOf = (d: FrameData): readonly SeriesFrame[] => (d.kind === 'series' ? d.series : []);

/** The index of `tMs` among `ts` (exact), else the last start at or before it; −1 if none. */
function columnAt(ts: Float64Array, tMs: number): number {
  let at = -1;
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i] ?? NaN;
    if (t === tMs) return i;
    if (t <= tMs) at = i;
  }
  return at;
}

/** The keyboard crosshair's selected row as the engine's item (`toMsEnd`: the view's end). */
export function hoverItemOf(
  spec: VisSpec,
  data: FrameData,
  hover: TimeHoverEvent,
  row: HoverRow,
  toMsEnd: number,
): Exclude<HoverItem, { kind: 'geo' }> {
  if (spec.kind === 'heatmap' && data.kind === 'heatmap') {
    const ts = data.heatmap.timestamps;
    const i = columnAt(ts, hover.tMs);
    return {
      kind: 'bucket',
      index: Number(row.key),
      tMs: hover.tMs,
      toMs: i < 0 ? toMsEnd : bucketEnd(ts, i, toMsEnd),
      count: row.value,
    };
  }
  return { kind: 'point', key: row.key, tMs: hover.tMs, value: row.value };
}

/**
 * The target of an item: a time chart's point or bucket, or a geomap mark (T24 §5.14): a
 * snapshot of the frame's rows, a `marker` for a row key and a `cluster` for `cluster:` + seed.
 */
export function targetOf(
  spec: VisSpec,
  data: FrameData,
  item: HoverItem,
  _names: ReadonlyMap<string, string> | null = null,
): InspectorTarget {
  if (item.kind === 'geo') {
    const geo = data.kind === 'geo' ? data.geo : null;
    const kind = item.id.startsWith('cluster:') ? ('cluster' as const) : ('marker' as const);
    return {
      type: 'geo',
      target: geoTarget(geo ?? EMPTY_SET, geo?.seq ?? 0, { kind, id: item.id, keys: item.keys }),
    };
  }
  if (item.kind === 'bucket') {
    const bounds = data.kind === 'heatmap' ? data.heatmap.bounds : new Float64Array(0);
    const lower = item.index === 0 ? null : (bounds[item.index - 1] ?? null);
    return {
      type: 'bucket',
      index: item.index,
      tMs: item.tMs,
      toMs: item.toMs,
      lower,
      upper: bounds[item.index] ?? NaN,
      count: item.count,
      countUnit: spec.kind === 'heatmap' ? spec.countUnit : { kind: 'none' },
    };
  }
  const s = seriesOf(data).find((x) => x.key === item.key);
  const labels = s?.labels ?? {};
  const name =
    spec.kind === 'bars' ? (labels[spec.categoryLabel] ?? seriesName(labels)) : seriesName(labels);
  return {
    type: 'point',
    vis: spec.kind === 'bars' ? 'bars' : 'line',
    key: item.key,
    labels,
    name,
    tMs: item.tMs,
    value: item.value,
  };
}

/** A stat's target: the first series' last finite sample, or the scalar (key null). */
export function statTarget(
  spec: Extract<VisSpec, { kind: 'stat' }>,
  data: FrameData,
  _names: ReadonlyMap<string, string> | null = null,
): Extract<InspectorTarget, { type: 'value' }> {
  if (data.kind === 'scalar') {
    return {
      type: 'value',
      key: null,
      labels: {},
      name: spec.title,
      value: data.scalar.value,
      tMs: Number.isFinite(data.scalar.timestampMs) ? data.scalar.timestampMs : null,
      state: null,
    };
  }
  const s = seriesOf(data)[0];
  let tMs: number | null = null;
  if (s !== undefined) {
    for (let i = s.values.length - 1; i >= 0; i--) {
      if (Number.isFinite(s.values[i] ?? NaN)) {
        tMs = s.timestamps[i] ?? null;
        break;
      }
    }
  }
  return {
    type: 'value',
    key: s?.key ?? null,
    labels: s?.labels ?? {},
    name: s === undefined ? spec.title : seriesName(s.labels),
    value: statValue(data),
    tMs,
    state: null,
  };
}

/** The selection an inspect writes (T25 §4.2). */
export function selectionOf(t: InspectorTarget): Selection {
  switch (t.type) {
    case 'point':
      return { keys: [t.key], fromMs: null, toMs: null };
    case 'bucket':
      return { keys: [], fromMs: t.tMs, toMs: t.toMs };
    case 'value':
      return { keys: t.key === null ? [] : [t.key], fromMs: null, toMs: null };
    case 'logLine': {
      const ms = Number(t.tsNs / 1_000_000n);
      return { keys: [t.streamKey], fromMs: ms, toMs: ms + 1 };
    }
    case 'mark': {
      // An aggregate (I3) selects its members; a bar its own key (T25 §4.2).
      const { mark, members } = t.target;
      return {
        keys: members === null ? [mark.key] : members.map((m) => m.key),
        fromMs: null,
        toMs: null,
      };
    }
    case 'geo':
      // A mark, cluster, group or the aggregate selects its rows (T24-092).
      return { keys: t.target.rows.map((r) => r.key), fromMs: null, toMs: null };
  }
}

/** The most names a cluster's tooltip lists, in seed order. */
const TOOLTIP_NAMES = 5;

/**
 * A geomap mark's tooltip lines (T24 §5.14): a marker `‹name›`, `‹value›[ · ‹state›]`, `‹place›`; a
 * cluster `Cluster of ‹n›`, `[worst ‹state›]`, its first five names in seed order `[, +k more]`.
 * The state parts only with thresholds.
 */
export function geoTooltip(
  geo: GeoFrame,
  item: Extract<HoverItem, { kind: 'geo' }>,
  unit: Unit,
): string[] {
  const byKey = new Map(geo.rows.map((r) => [r.key, r]));
  const rows = item.keys.map((k) => byKey.get(k)).filter((r): r is GeoRow => r !== undefined);
  if (!item.id.startsWith('cluster:')) {
    const r = rows[0];
    if (r === undefined) return [];
    const value = formatValue(r.value, unit);
    const lines = [r.name, r.state === null ? value : `${value} · ${r.state}`];
    const place = geoPlace(r);
    if (place !== '') lines.push(place);
    return lines;
  }
  const lines = [t('geo.cluster.title', { n: rows.length })];
  const worst = worstState(rows);
  if (worst !== null) lines.push(t('geo.list.worst', { state: worst }));
  const names = seedOrdered(rows).map((r) => r.name);
  const shown = names.slice(0, TOOLTIP_NAMES).join(', ');
  const more = names.length - TOOLTIP_NAMES;
  lines.push(more > 0 ? `${shown}, ${t('geo.tooltip.more', { k: more })}` : shown);
  return lines;
}
