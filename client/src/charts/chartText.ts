/** The text of a chart frame (plan #58 §3.5, §3.8): summary label, crosshair, rows, issues. */
import type { FrameDataIssue } from '../data/frames';
import type {
  EventKind,
  EventMarker,
  FrameSummary,
  HoverEvent,
  HoverRow,
  PlotRect,
  ThresholdState,
  Unit,
  VisSpec,
} from '../engine/api';
import { formatRangeShort, formatTime, formatValue } from '../i18n/format';
import { t, type MessageId } from '../i18n/t';

/** Rows the tooltip shows at once. */
export const TOOLTIP_ROWS = 20;

const KIND: Readonly<Record<VisSpec['kind'], MessageId>> = {
  line: 'chart.kind.line',
  bars: 'chart.kind.bars',
  heatmap: 'chart.kind.heatmap',
  stat: 'chart.kind.stat',
};

/**
 * The state names of `StateEncoding[s].label`, read here by id: the e2e specs import this module
 * in Node, where `StateEncoding`'s CSS module does not load.
 */
const STATE_LABEL: Readonly<Record<ThresholdState, MessageId>> = {
  watch: 'state.watch',
  degraded: 'state.degraded',
  failing: 'state.failing',
};

const EVENT_KIND: Readonly<Record<EventKind, MessageId>> = {
  deploy: 'event.kind.deploy',
  config: 'event.kind.config',
  flag: 'event.kind.flag',
  annotation: 'event.kind.annotation',
};

/**
 * The tooltip and accessible name of an event label box (plan #64 Part C §3.7): per member,
 * `{kind} · {title} · {time}`, with `–{end}` when it is ranged, joined by '; '.
 */
export function eventText(
  ids: readonly string[],
  events: ReadonlyMap<string, EventMarker>,
  tz: string,
): string {
  const out: string[] = [];
  for (const id of ids) {
    const e = events.get(id);
    if (e === undefined) continue;
    const end = e.endMs === null ? '' : `–${formatTime(e.endMs, tz)}`;
    out.push(`${t(EVENT_KIND[e.kind])} · ${e.title} · ${formatTime(e.atMs, tz)}${end}`);
  }
  return out.join('; ');
}

/** The unit of the values a frame reports: heatmap counts use `countUnit`. */
export function valueUnit(spec: VisSpec): Unit {
  return spec.kind === 'heatmap' ? spec.countUnit : spec.unit;
}

/** Value descending, then name ascending. */
export function sortedRows(rows: readonly HoverRow[]): HoverRow[] {
  return [...rows].sort((a, b) => {
    if (a.value !== b.value) return b.value - a.value;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

/** Keyboard: the ≤ 20-row slice centred on the selected row (clamped to the ends), as [start, end). */
export function rowWindow(n: number, selected: number): [number, number] {
  const start = Math.min(Math.max(0, n - TOOLTIP_ROWS), Math.max(0, selected - TOOLTIP_ROWS / 2));
  return [start, Math.min(n, start + TOOLTIP_ROWS)];
}

/** Pointer: start = round(clamp01((yCss − plot.y)/plot.height) · max(0, n − 20)). */
export function pointerWindowStart(n: number, yCss: number, plot: PlotRect): number {
  const f = plot.height > 0 ? Math.min(1, Math.max(0, (yCss - plot.y) / plot.height)) : 0;
  return Math.round(f * Math.max(0, n - TOOLTIP_ROWS));
}

/**
 * `Thresholds: {list}.` (#64 Part B §3.9.1): every threshold line of a line or bars spec, in spec
 * order, as `{state} {label}` joined by `; `, whether drawn, stacked, truncated or off-axis; ''
 * when there is none.
 */
export function thresholdsText(spec: VisSpec): string {
  const lines = spec.kind === 'line' || spec.kind === 'bars' ? (spec.thresholds ?? []) : [];
  if (lines.length === 0) return '';
  const list = lines.map((l) => `${t(STATE_LABEL[l.state])} ${l.label}`).join('; ');
  return t('chart.thresholds', { list });
}

/**
 * `{title}: {kind}, {count} {noun}, {range}. Min {min}, max {max}, last {last}.`, then
 * `Y axis fixed at {min} to {max}.` while the value axis is pinned (#93), then the thresholds,
 * then `Events in view: {count}.` when the frame has event labels (ADR-0023).
 */
export function summaryLabel(spec: VisSpec, s: FrameSummary, tz: string): string {
  const base = summaryBase(spec, s, tz);
  const th = thresholdsText(spec);
  const withThresholds = th === '' ? base : `${base} ${th}`;
  let count = 0;
  for (const b of s.eventLabels) count += b.ids.length;
  return count === 0 ? withThresholds : `${withThresholds} ${t('chart.events', { count })}`;
}

function summaryBase(spec: VisSpec, s: FrameSummary, tz: string): string {
  const unit = valueUnit(spec);
  const v = (x: number | null): string => (x === null ? '—' : formatValue(x, unit));
  const text = t('chart.summary', {
    title: spec.title,
    kind: t(KIND[spec.kind]),
    count: s.seriesTotal,
    noun: t(spec.kind === 'heatmap' ? 'chart.noun.buckets' : 'chart.noun.series'),
    range: formatRangeShort(s.fromMs, s.toMs, tz),
    min: v(s.min),
    max: v(s.max),
    last: v(s.last),
  });
  const a = s.valueAxis;
  if (a?.manual !== true) return text;
  return `${text} ${t('chart.valueAxis.pinned', { min: v(a.min), max: v(a.max) })}`;
}

/** The slider's value text: the selected row of `sortedRows` at the crosshair, or the idle hint. */
export function crosshairText(
  spec: VisSpec,
  h: HoverEvent | null,
  tz: string,
  selected = 0,
): string {
  if (h === null) return t('chart.crosshair.idle');
  const time = formatTime(h.tMs, tz);
  const rows = sortedRows(h.rows);
  const i = Math.min(Math.max(0, selected), rows.length - 1);
  const row = rows[i];
  if (row === undefined) return time;
  return t('chart.crosshair.value', {
    time,
    name: row.name,
    value: formatValue(row.value, valueUnit(spec)),
    index: i + 1,
    total: rows.length,
  });
}

/** The reason an invalid frame cannot be drawn. */
export function issueText(i: FrameDataIssue): string {
  switch (i.code) {
    case 'kind':
      return t('chart.issue.kind');
    case 'key':
      return t('chart.issue.key', { key: i.key });
    case 'length':
      return t('chart.issue.length', { key: i.key, timestamps: i.timestamps, values: i.values });
    case 'order':
      return t('chart.issue.order', { key: i.key });
    case 'cells':
      return t('chart.issue.cells', { columns: i.columns, buckets: i.buckets, cells: i.cells });
    case 'bounds':
      return t('chart.issue.bounds');
    case 'finite':
      return t('chart.issue.finite');
    case 'grid':
      return t('chart.issue.grid', { key: i.key });
  }
}
