/**
 * The Canvas 2D marks (plan #58 §4.1): axes, line, stacked bars, heatmap, stat and the overlay.
 * Every colour comes from `ThemeColours` (generated tokens); every number goes through
 * `formatValue` (T08-027). The layer functions return what picking and the overlay need.
 */
import { font, size, space } from '../../styles/tokens';
import type { FrameData, HeatmapFrame, SeriesFrame } from '../../data/frames';
import { formatValue, type Unit } from '../../i18n/format';
import type { FrameSummary, HoverEvent, PlotRect, TimeWindow, VisSpec } from '../api';
import { bucketScale, type BucketScale } from './bucketScale';
import { columnCount, lineColumns, mergeBuckets, type Column } from './columns';
import type { Ctx2D } from './ctx';
import { LABEL_HEIGHT, layoutPlot } from './layout';
import { rampIndex, seriesColourIndex, type ThemeColours } from './palette';
import {
  barStats,
  extent,
  frameSummary,
  heatmapStats,
  lineStats,
  stackedTotals,
  statValue,
} from './summary';
import { timeTicks } from './timeTicks';
import { valueTicks } from './valueTicks';

/** Canvas fonts (plan #58 Appendix A §A.3). */
export const AXIS_FONT = `${String(font.size.xs)}px ${font.family.mono}`;
export const STAT_FONT = `${String(font.weight.semibold)} ${String(font.size.display)}px ${font.family.ui}`;

/** The most series a frame draws (ADR-0014 §4). */
export const MAX_SERIES = 500;

export interface LayerInput {
  readonly ctx: Ctx2D;
  readonly spec: VisSpec;
  readonly data: FrameData;
  readonly window: TimeWindow;
  readonly cssW: number;
  readonly cssH: number;
  readonly timeZone: string;
  readonly colours: ThemeColours;
}

/** What picking and the overlay need from the last layer draw. */
export type PickModel =
  | {
      readonly kind: 'line';
      readonly ref: Float64Array;
      readonly series: readonly SeriesFrame[];
      readonly y: (v: number) => number;
    }
  | {
      readonly kind: 'bars';
      readonly ref: Float64Array;
      readonly series: readonly SeriesFrame[];
      readonly categoryLabel: string;
    }
  | {
      readonly kind: 'heatmap';
      readonly ref: Float64Array;
      readonly heatmap: HeatmapFrame;
      readonly scale: BucketScale;
      readonly unit: Unit;
    };

export interface LayerModel {
  readonly summary: FrameSummary;
  readonly pick: PickModel | null;
}

interface AxisLabel {
  readonly y: number;
  readonly label: string;
}

const isPlotEmpty = (p: PlotRect): boolean => !(p.width > 0) || !(p.height > 0);

function xOf(plot: PlotRect, w: TimeWindow, t: number): number {
  return plot.x + ((t - w.fromMs) / (w.toMs - w.fromMs)) * plot.width;
}

function labelWidth(ctx: Ctx2D, labels: readonly string[]): number {
  ctx.font = AXIS_FONT;
  let w = 0;
  for (const l of labels) w = Math.max(w, ctx.measureText(l).width);
  return Math.ceil(w);
}

/** Value labels (and grid lines when `grid`), then the time axis along the plot bottom. */
export function drawAxes(
  i: LayerInput,
  plot: PlotRect,
  values: readonly AxisLabel[],
  grid: boolean,
): void {
  const { ctx, colours } = i;
  ctx.font = AXIS_FONT;
  if (grid) {
    ctx.fillStyle = colours.grid;
    for (const v of values) ctx.fillRect(plot.x, Math.round(v.y), plot.width, 1);
  }
  ctx.fillStyle = colours.axisText;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const labelX = plot.x - size['chart-tick'] - space['1'];
  for (const v of values) ctx.fillText(v.label, labelX, v.y);
  const ticks = timeTicks({
    fromMs: i.window.fromMs,
    toMs: i.window.toMs,
    widthPx: plot.width,
    timeZone: i.timeZone,
    measure: (s) => ctx.measureText(s).width,
    minGapPx: space['2'],
  });
  const bottom = plot.y + plot.height;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const t of ticks) {
    const x = Math.round(plot.x + t.x);
    ctx.fillRect(x, bottom, 1, size['chart-tick']);
    ctx.fillText(t.label, plot.x + t.x, bottom + size['chart-tick'] + space['1']);
  }
}

/**
 * One line series: one vertex per non-null column at its last value (a new subpath after a gap),
 * one 1-px span per NaN-free run of a dense column, and a dot for a lone sample between gaps.
 */
export function drawLineSeries(
  ctx: Ctx2D,
  cols: readonly (Column | null)[],
  plot: PlotRect,
  y: (v: number) => number,
  colour: string,
  lineWidth: number,
): void {
  ctx.fillStyle = colour;
  for (const c of cols) {
    if (c === null || c.count <= 1) continue;
    for (const r of c.runs) {
      const top = y(r.max);
      ctx.fillRect(plot.x + c.x, top, 1, Math.max(1, y(r.min) - top));
    }
  }
  ctx.strokeStyle = colour;
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  const dots: Column[] = [];
  // Columns without a sample are skipped: the path joins the nearest drawn columns and breaks only
  // where a NaN lies between them (`breakBefore`).
  const drawn = cols.filter((c): c is Column => c !== null);
  drawn.forEach((c, k) => {
    const next = drawn[k + 1];
    const starts = k === 0 || c.breakBefore;
    const continued = next !== undefined && !next.breakBefore;
    const vx = plot.x + c.x + 0.5;
    if (!starts) ctx.lineTo(vx, y(c.last));
    else if (!continued && c.count === 1) dots.push(c);
    else ctx.moveTo(vx, y(c.last));
  });
  ctx.stroke();
  for (const c of dots) {
    ctx.beginPath();
    ctx.arc(plot.x + c.x + 0.5, y(c.last), lineWidth, 0, 2 * Math.PI);
    ctx.fill();
  }
}

function valueAxis(
  i: LayerInput,
  dataMin: number,
  dataMax: number,
  unit: Unit,
): { plot: PlotRect; y: (v: number) => number; labels: AxisLabel[] } {
  const height = layoutPlot(i.spec.kind, i.cssW, i.cssH, 0).height;
  const vt = valueTicks(
    Math.min(0, dataMin),
    dataMax,
    height,
    LABEL_HEIGHT,
    unit.kind === 'bytes' ? 1024 : 1000,
  );
  const texts = vt.ticks.map((t) => formatValue(t, unit));
  const plot = layoutPlot(i.spec.kind, i.cssW, i.cssH, labelWidth(i.ctx, texts));
  const y = (v: number): number => plot.y + (1 - (v - vt.min) / (vt.max - vt.min)) * plot.height;
  return { plot, y, labels: vt.ticks.map((t, k) => ({ y: y(t), label: texts[k] ?? '' })) };
}

function drawLine(i: LayerInput, series: readonly SeriesFrame[]): LayerModel {
  const shown = series.slice(0, MAX_SERIES);
  const stats = lineStats(shown);
  const { plot, y, labels } = valueAxis(i, stats.min ?? 0, stats.max ?? 0, i.spec.unit);
  const summary = frameSummary('line', i.window, plot, series.length, shown.length, stats);
  const pick: PickModel = {
    kind: 'line',
    ref: shown[0]?.timestamps ?? new Float64Array(0),
    series: shown,
    y,
  };
  if (isPlotEmpty(plot)) return { summary, pick };
  drawAxes(i, plot, labels, true);
  for (const s of shown) {
    const cols = lineColumns(s.timestamps, s.values, i.window, plot);
    drawLineSeries(
      i.ctx,
      cols,
      plot,
      y,
      i.colours.series[seriesColourIndex(s)] ?? '',
      size['chart-line'],
    );
  }
  return { summary, pick };
}

/** Bars and heatmap columns: [x, width] of bucket `k` of `ts`, clamped to the plot; null outside. */
function bucketSpan(
  plot: PlotRect,
  w: TimeWindow,
  ts: Float64Array,
  k: number,
): [number, number] | null {
  const t = ts[k] ?? NaN;
  const n = ts.length;
  const end = k + 1 < n ? (ts[k + 1] ?? t) : n === 1 ? w.toMs : t + (t - (ts[n - 2] ?? t));
  const x0 = Math.max(plot.x, Math.round(xOf(plot, w, t)));
  const x1 = Math.min(plot.x + plot.width, Math.round(xOf(plot, w, end)));
  if (!(x1 > x0)) return null;
  return [x0, Math.max(1, x1 - x0 - 1)];
}

/** Category order: `categoryOrder` index, then unlisted categories by name, then key. */
export function orderCategories(
  series: readonly SeriesFrame[],
  label: string,
  order: readonly string[],
): SeriesFrame[] {
  const rank = (s: SeriesFrame): number => {
    const i = order.indexOf(s.labels[label] ?? '');
    return i < 0 ? order.length : i;
  };
  return [...series].sort((a, b) => {
    const d = rank(a) - rank(b);
    if (d !== 0) return d;
    const na = a.labels[label] ?? '';
    const nb = b.labels[label] ?? '';
    if (na !== nb) return na < nb ? -1 : 1;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

function drawBars(
  i: LayerInput,
  spec: Extract<VisSpec, { kind: 'bars' }>,
  series: readonly SeriesFrame[],
): LayerModel {
  const shown = orderCategories(series, spec.categoryLabel, spec.categoryOrder).slice(
    0,
    MAX_SERIES,
  );
  const ref = shown[0]?.timestamps ?? new Float64Array(0);
  const stats = barStats(shown);
  const c = shown.length;
  // Row-major by time: grid[t·C + c].
  let ts: Float64Array = ref;
  let grid: Float64Array = new Float64Array(ref.length * c);
  shown.forEach((s, k) => {
    s.values.forEach((v, t) => (grid[t * c + k] = v));
  });
  const first = valueAxis(i, stats.min ?? 0, stats.max ?? 0, spec.unit);
  if (ts.length > columnCount(first.plot)) {
    ({ ts, counts: grid } = mergeBuckets(ts, grid, c, i.window, first.plot));
  }
  const merged: SeriesFrame[] = shown.map((s, k) => ({
    ...s,
    timestamps: ts,
    values: Float64Array.from({ length: ts.length }, (_, t) => grid[t * c + k] ?? 0),
  }));
  const range = extent(stackedTotals(merged));
  const { plot, y, labels } = valueAxis(
    i,
    Math.min(range?.min ?? 0, 0),
    Math.max(range?.max ?? 0, 0),
    spec.unit,
  );
  const summary = frameSummary('bars', i.window, plot, series.length, shown.length, stats);
  const pick: PickModel = { kind: 'bars', ref, series: shown, categoryLabel: spec.categoryLabel };
  if (isPlotEmpty(plot)) return { summary, pick };
  drawAxes(i, plot, labels, true);
  for (let t = 0; t < ts.length; t++) {
    const span = bucketSpan(plot, i.window, ts, t);
    if (span === null) continue;
    let acc = 0;
    merged.forEach((s, k) => {
      const v = s.values[t] ?? 0;
      if (!(v > 0)) return;
      const top = y(acc + v);
      i.ctx.fillStyle = i.colours.series[seriesColourIndex(shown[k] ?? s)] ?? '';
      i.ctx.fillRect(span[0], top, span[1], y(acc) - top);
      acc += v;
    });
  }
  return { summary, pick };
}

function drawHeatmap(
  i: LayerInput,
  spec: Extract<VisSpec, { kind: 'heatmap' }>,
  h: HeatmapFrame,
): LayerModel {
  const nb = h.bounds.length;
  const stats = heatmapStats(h);
  const plot0 = layoutPlot('heatmap', i.cssW, i.cssH, 0);
  const empty = nb === 0 || h.timestamps.length === 0;
  const scale0 = empty ? null : bucketScale(h.bounds, plot0, LABEL_HEIGHT);
  const texts = (scale0?.ticks ?? []).map((t) => formatValue(t, spec.unit));
  if (scale0?.infBand !== null && scale0 !== null) texts.push('+Inf');
  const plot = layoutPlot('heatmap', i.cssW, i.cssH, labelWidth(i.ctx, texts));
  const summary = frameSummary('heatmap', i.window, plot, nb, nb, stats);
  if (empty || isPlotEmpty(plot)) return { summary, pick: null };
  const scale = bucketScale(h.bounds, plot, LABEL_HEIGHT);
  const labels: AxisLabel[] = scale.ticks.map((t) => ({
    y: scale.y(t),
    label: formatValue(t, spec.unit),
  }));
  if (scale.infBand !== null)
    labels.push({ y: (scale.infBand.y0 + scale.infBand.y1) / 2, label: '+Inf' });
  drawAxes(i, plot, labels, false);
  let ts = h.timestamps;
  let counts = h.counts;
  if (ts.length > columnCount(plot))
    ({ ts, counts } = mergeBuckets(ts, counts, nb, i.window, plot));
  let maxCount = 0;
  for (const c of counts) if (c > maxCount) maxCount = c;
  for (let t = 0; t < ts.length; t++) {
    const span = bucketSpan(plot, i.window, ts, t);
    if (span === null) continue;
    for (let b = 0; b < nb; b++) {
      const r = rampIndex(counts[t * nb + b] ?? 0, maxCount);
      if (r === null) continue;
      const row = scale.rows[b];
      const band = row === undefined ? scale.infBand : { y0: row.y1, y1: row.y0 };
      if (band === null) continue;
      i.ctx.fillStyle = i.colours.ramp[r] ?? '';
      i.ctx.fillRect(span[0], band.y0, span[1], band.y1 - band.y0);
    }
  }
  return {
    summary,
    pick: { kind: 'heatmap', ref: h.timestamps, heatmap: h, scale, unit: spec.unit },
  };
}

function drawStat(i: LayerInput): LayerModel {
  const v = statValue(i.data);
  const plot = layoutPlot('stat', i.cssW, i.cssH, 0);
  const shown = Number.isFinite(v) ? v : null;
  const summary = frameSummary('stat', i.window, plot, 1, 1, {
    min: shown,
    max: shown,
    last: shown,
  });
  const { ctx } = i;
  ctx.font = STAT_FONT;
  ctx.fillStyle = i.colours.text;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(formatValue(v, i.spec.unit), i.cssW / 2, i.cssH / 2);
  return { summary, pick: null };
}

/** The background and the marks of `spec`'s kind. */
export function drawLayer(i: LayerInput): LayerModel {
  i.ctx.fillStyle = i.colours.background;
  i.ctx.fillRect(0, 0, i.cssW, i.cssH);
  const { spec, data } = i;
  switch (spec.kind) {
    case 'line':
      return drawLine(i, data.kind === 'series' ? data.series : []);
    case 'bars':
      return drawBars(i, spec, data.kind === 'series' ? data.series : []);
    case 'heatmap':
      return drawHeatmap(
        i,
        spec,
        data.kind === 'heatmap'
          ? data.heatmap
          : {
              timestamps: new Float64Array(0),
              bounds: new Float64Array(0),
              counts: new Float64Array(0),
            },
      );
    case 'stat':
      return drawStat(i);
  }
}

/** The crosshair, the hovered line values and the brush band, over the blitted layer. */
export function drawOverlay(
  ctx: Ctx2D,
  model: LayerModel,
  colours: ThemeColours,
  hover: HoverEvent | null,
  brush: { x0: number; x: number } | null,
): void {
  const { plot } = model.summary;
  if (hover !== null) {
    ctx.fillStyle = colours.crosshair;
    ctx.fillRect(Math.round(hover.xCss), plot.y, 1, plot.height);
    const pick = model.pick;
    if (pick?.kind === 'line') {
      for (const r of hover.rows) {
        ctx.fillStyle = colours.series[r.colourIndex ?? 0] ?? '';
        ctx.beginPath();
        ctx.arc(hover.xCss, pick.y(r.value), size['chart-line'] * 2, 0, 2 * Math.PI);
        ctx.fill();
      }
    }
  }
  if (brush !== null) {
    ctx.fillStyle = colours.brush;
    ctx.fillRect(Math.min(brush.x0, brush.x), plot.y, Math.abs(brush.x - brush.x0), plot.height);
  }
}
