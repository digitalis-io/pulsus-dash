/**
 * Inspector targets of the chart kinds (T25 §4.2, T25-002, plan #192 §3): the engine's `HoverItem`
 * of a keyboard row, the `InspectorTarget` an item names, and the selection an inspect writes.
 */
import { bucketEnd, seriesName, statValue, type SeriesFrame } from '../data/frames';
import type { FrameData, HoverEvent, HoverItem, HoverRow, VisSpec } from '../engine/api';
import type { InspectorTarget, Selection } from '../inspector/types';

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
  hover: HoverEvent,
  row: HoverRow,
  toMsEnd: number,
): HoverItem {
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

export function targetOf(spec: VisSpec, data: FrameData, item: HoverItem): InspectorTarget {
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
  }
}
