/**
 * The Canvas 2D marks (plan #58 §4.1): axes, line, stacked bars, heatmap, stat and the overlay.
 * Every colour comes from `ThemeColours` (generated tokens); every number goes through
 * `formatValue` or `formatCompact` (T08-027). The layer functions return what picking, the overlay
 * and the camera (#93) need: the value-label band width, the value domain and whether the band
 * was held.
 *
 * Value labels (T02-011 as amended by #93): the band is at least as wide as the widest compact
 * label of the unit (`minValueBand`). Under a held band (`LayerInput.band`), each tick label is
 * drawn in full when it fits, else in compact form, else whole inside the plot on a chip; the plot
 * rectangle then depends only on the held width.
 */
import { font, radius, size, space } from '../../styles/tokens';
import type { FrameData, HeatmapFrame, SeriesFrame } from '../../data/frames';
import { compactSamples, formatCompact, formatValue, type Unit } from '../../i18n/format';
import type { FrameSummary, HoverEvent, PlotRect, TimeWindow, ValueRange, VisSpec } from '../api';
import { bucketScale, type BucketScale } from './bucketScale';
import { bucketEnd, columnCount, lineColumns, mergeBuckets, type Column } from './columns';
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
  type Stats,
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
  /** Manual value range (line, bars); null = auto. */
  readonly valueRange: ValueRange | null;
  /** Held value-label band width (#93); null = measure. */
  readonly band: number | null;
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
  /** The value-label band width the layout used. */
  readonly labelW: number;
  /** The value axis mapping domain (line, bars); null for heatmap and stat. */
  readonly valueDomain: ValueRange | null;
  /** True when the layout used `i.band`. */
  readonly bandHeld: boolean;
}

interface AxisLabel {
  readonly y: number;
  readonly label: string;
  /** Drawn whole inside the plot on a chip: no form of it fits the held band (#93). */
  readonly chip: boolean;
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

/** Per context: the minimum band of each unit (`minValueBand`). */
const bandCache = new WeakMap<Ctx2D, Map<string, number>>();

/**
 * ceil(max measureText(compactSamples(unit))) in `AXIS_FONT`: the narrowest value-label band, so a
 * whole compact label always fits (T02-011). Cached per context and unit key.
 */
export function minValueBand(ctx: Ctx2D, unit: Unit): number {
  let m = bandCache.get(ctx);
  if (m === undefined) {
    m = new Map();
    bandCache.set(ctx, m);
  }
  const key = JSON.stringify(unit);
  let w = m.get(key);
  if (w === undefined) {
    w = labelWidth(ctx, compactSamples(unit));
    m.set(key, w);
  }
  return w;
}

/** Drops the cached minimum bands of `ctx` (its fonts changed). */
export function forgetValueBands(ctx: Ctx2D): void {
  bandCache.delete(ctx);
}

interface HeldLabel {
  readonly text: string;
  readonly chip: boolean;
}

function heldLabels(ctx: Ctx2D, ticks: readonly number[], unit: Unit, band: number): HeldLabel[] {
  ctx.font = AXIS_FONT;
  return ticks.map((t) => {
    const full = formatValue(t, unit);
    if (ctx.measureText(full).width <= band) return { text: full, chip: false };
    const compact = formatCompact(t, unit);
    if (ctx.measureText(compact).width <= band) return { text: compact, chip: false };
    return { text: full, chip: true };
  });
}

/**
 * Labels for a held band: per tick, the full label when it measures ≤ band, else `formatCompact`;
 * null when some compact label still measures > band (the layer then chips that label, #93).
 */
export function holdLabels(
  ctx: Ctx2D,
  ticks: readonly number[],
  unit: Unit,
  band: number,
): string[] | null {
  const l = heldLabels(ctx, ticks, unit, band);
  return l.some((x) => x.chip) ? null : l.map((x) => x.text);
}

/** The tick labels and the band they need: held (`i.band`) or measured (at least the minimum). */
function axisTexts(
  i: LayerInput,
  ticks: readonly number[],
  unit: Unit,
  extra: readonly string[] = [],
): { texts: HeldLabel[]; width: number; held: boolean } {
  if (i.band !== null) {
    const texts = heldLabels(i.ctx, ticks, unit, i.band);
    for (const e of extra) texts.push({ text: e, chip: false });
    return { texts, width: i.band, held: true };
  }
  const plain = [...ticks.map((t) => formatValue(t, unit)), ...extra];
  const width = Math.max(labelWidth(i.ctx, plain), minValueBand(i.ctx, unit));
  return { texts: plain.map((text) => ({ text, chip: false })), width, held: false };
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
  for (const v of values) if (!v.chip) ctx.fillText(v.label, labelX, v.y);
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
 * Value labels no form of which fits the held band: whole, inside the plot, the text's left edge
 * at `plot.x + space.1`, over the marks on a chip (the tooltip surface and corner radius, padding
 * `space.1`; T02-011 as amended by #93).
 */
function drawChips(i: LayerInput, plot: PlotRect, values: readonly AxisLabel[]): void {
  const { ctx } = i;
  const pad = space['1'];
  const h = LABEL_HEIGHT;
  const r = Math.min(radius.default, h / 2);
  ctx.font = AXIS_FONT;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (const v of values) {
    if (!v.chip) continue;
    const w = ctx.measureText(v.label).width + 2 * pad;
    const x0 = plot.x;
    const y0 = v.y - h / 2;
    ctx.fillStyle = i.colours.chip;
    ctx.beginPath();
    ctx.moveTo(x0 + r, y0);
    ctx.lineTo(x0 + w - r, y0);
    ctx.arc(x0 + w - r, y0 + r, r, -Math.PI / 2, 0);
    ctx.lineTo(x0 + w, y0 + h - r);
    ctx.arc(x0 + w - r, y0 + h - r, r, 0, Math.PI / 2);
    ctx.lineTo(x0 + r, y0 + h);
    ctx.arc(x0 + r, y0 + h - r, r, Math.PI / 2, Math.PI);
    ctx.lineTo(x0, y0 + r);
    ctx.arc(x0 + r, y0 + r, r, Math.PI, (3 * Math.PI) / 2);
    ctx.fill();
    ctx.fillStyle = i.colours.axisText;
    ctx.fillText(v.label, x0 + pad, v.y);
  }
}

/** Runs `marks` clipped to the plot when the value axis is manual (#93), else as is. */
function clipped(i: LayerInput, plot: PlotRect, marks: () => void): void {
  if (i.valueRange === null) {
    marks();
    return;
  }
  const { ctx } = i;
  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.x, plot.y, plot.width, plot.height);
  ctx.clip();
  marks();
  ctx.restore();
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

interface ValueAxis {
  readonly plot: PlotRect;
  readonly y: (v: number) => number;
  readonly labels: AxisLabel[];
  readonly domain: ValueRange;
  readonly labelW: number;
  readonly held: boolean;
}

/** The value axis of line and bars: auto from the data, or the manual range (#93). */
function valueAxis(i: LayerInput, dataMin: number, dataMax: number, unit: Unit): ValueAxis {
  const height = layoutPlot(i.spec.kind, i.cssW, i.cssH, 0).height;
  const base = unit.kind === 'bytes' ? 1024 : 1000;
  const r = i.valueRange;
  let ticks: readonly number[];
  let domain: ValueRange;
  if (r !== null) {
    const tol = 1e-9 * (r.max - r.min);
    ticks = valueTicks(r.min, r.max, height, LABEL_HEIGHT, base).ticks.filter(
      (t) => t >= r.min - tol && t <= r.max + tol,
    );
    domain = r;
  } else {
    const vt = valueTicks(Math.min(0, dataMin), dataMax, height, LABEL_HEIGHT, base);
    ticks = vt.ticks;
    domain = { min: vt.min, max: vt.max };
  }
  const { texts, width, held } = axisTexts(i, ticks, unit);
  const plot = layoutPlot(i.spec.kind, i.cssW, i.cssH, width);
  const y = (v: number): number =>
    plot.y + (1 - (v - domain.min) / (domain.max - domain.min)) * plot.height;
  const labels = ticks.map((t, k) => ({
    y: y(t),
    label: texts[k]?.text ?? '',
    chip: texts[k]?.chip ?? false,
  }));
  return { plot, y, labels, domain, labelW: width, held };
}

const axisSummary = (i: LayerInput, a: ValueAxis): FrameSummary['valueAxis'] => ({
  min: a.domain.min,
  max: a.domain.max,
  manual: i.valueRange !== null,
});

function lineModel(i: LayerInput, series: readonly SeriesFrame[]) {
  const shown = series.slice(0, MAX_SERIES);
  const stats = lineStats(shown);
  const axis = valueAxis(i, stats.min ?? 0, stats.max ?? 0, i.spec.unit);
  return { shown, stats, axis };
}

function drawLine(i: LayerInput, series: readonly SeriesFrame[]): LayerModel {
  const { shown, stats, axis } = lineModel(i, series);
  const { plot, y, labels } = axis;
  const summary = frameSummary(
    'line',
    i.window,
    plot,
    series.length,
    shown.length,
    stats,
    axisSummary(i, axis),
  );
  const pick: PickModel = {
    kind: 'line',
    ref: shown[0]?.timestamps ?? new Float64Array(0),
    series: shown,
    y,
  };
  const model = {
    summary,
    pick,
    labelW: axis.labelW,
    valueDomain: axis.domain,
    bandHeld: axis.held,
  };
  if (isPlotEmpty(plot)) return model;
  drawAxes(i, plot, labels, true);
  clipped(i, plot, () => {
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
  });
  drawChips(i, plot, labels);
  return model;
}

/**
 * Bars and heatmap columns: [x, width] of bucket `k` of `ts`, clamped to the plot; null outside.
 * `lastEnd` overrides the last bucket's end (the clipped end reported by `mergeBuckets`).
 */
function bucketSpan(
  plot: PlotRect,
  w: TimeWindow,
  ts: Float64Array,
  k: number,
  lastEnd?: number,
): [number, number] | null {
  const t = ts[k] ?? NaN;
  const end = k + 1 === ts.length && lastEnd !== undefined ? lastEnd : bucketEnd(ts, k, w.toMs);
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

interface BarsModel {
  readonly shown: SeriesFrame[];
  readonly ref: Float64Array;
  readonly stats: Stats;
  readonly ts: Float64Array;
  readonly merged: SeriesFrame[];
  readonly lastEnd: number | undefined;
  readonly axis: ValueAxis;
}

/** The bars' categories, merged buckets and value axis; paints nothing. */
function barsModel(
  i: LayerInput,
  spec: Extract<VisSpec, { kind: 'bars' }>,
  series: readonly SeriesFrame[],
): BarsModel {
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
  let lastEnd: number | undefined;
  if (ts.length > columnCount(first.plot)) {
    ({ ts, counts: grid, endMs: lastEnd } = mergeBuckets(ts, grid, c, i.window, first.plot));
  }
  const merged: SeriesFrame[] = shown.map((s, k) => ({
    ...s,
    timestamps: ts,
    values: Float64Array.from({ length: ts.length }, (_, t) => grid[t * c + k] ?? 0),
  }));
  const range = extent(stackedTotals(merged));
  const axis = valueAxis(i, Math.min(range?.min ?? 0, 0), Math.max(range?.max ?? 0, 0), spec.unit);
  return { shown, ref, stats, ts, merged, lastEnd, axis };
}

function drawBars(
  i: LayerInput,
  spec: Extract<VisSpec, { kind: 'bars' }>,
  series: readonly SeriesFrame[],
): LayerModel {
  const { shown, ref, stats, ts, merged, lastEnd, axis } = barsModel(i, spec, series);
  const { plot, y, labels } = axis;
  const summary = frameSummary(
    'bars',
    i.window,
    plot,
    series.length,
    shown.length,
    stats,
    axisSummary(i, axis),
  );
  const pick: PickModel = { kind: 'bars', ref, series: shown, categoryLabel: spec.categoryLabel };
  const model = {
    summary,
    pick,
    labelW: axis.labelW,
    valueDomain: axis.domain,
    bandHeld: axis.held,
  };
  if (isPlotEmpty(plot)) return model;
  drawAxes(i, plot, labels, true);
  clipped(i, plot, () => {
    for (let t = 0; t < ts.length; t++) {
      const span = bucketSpan(plot, i.window, ts, t, lastEnd);
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
  });
  drawChips(i, plot, labels);
  return model;
}

/** The heatmap's bucket-axis labels and the band they need (`+Inf` last when there is one). */
function heatmapAxis(i: LayerInput, h: HeatmapFrame, unit: Unit) {
  const empty = h.bounds.length === 0 || h.timestamps.length === 0;
  const plot0 = layoutPlot('heatmap', i.cssW, i.cssH, 0);
  const scale0 = empty ? null : bucketScale(h.bounds, plot0, LABEL_HEIGHT);
  const inf = scale0 !== null && scale0.infBand !== null ? ['+Inf'] : [];
  const { width, held } = axisTexts(i, scale0?.ticks ?? [], unit, inf);
  return { empty, width, held };
}

function emptyHeatmap(): HeatmapFrame {
  return {
    timestamps: new Float64Array(0),
    bounds: new Float64Array(0),
    counts: new Float64Array(0),
  };
}

function drawHeatmap(
  i: LayerInput,
  spec: Extract<VisSpec, { kind: 'heatmap' }>,
  h: HeatmapFrame,
): LayerModel {
  const nb = h.bounds.length;
  const stats = heatmapStats(h);
  const { empty, width, held } = heatmapAxis(i, h, spec.unit);
  const plot = layoutPlot('heatmap', i.cssW, i.cssH, width);
  const summary = frameSummary('heatmap', i.window, plot, nb, nb, stats, null);
  const base = { summary, labelW: width, valueDomain: null, bandHeld: held };
  if (empty || isPlotEmpty(plot)) return { ...base, pick: null };
  const scale = bucketScale(h.bounds, plot, LABEL_HEIGHT);
  const { texts } = axisTexts(i, scale.ticks, spec.unit);
  const labels: AxisLabel[] = scale.ticks.map((t, k) => ({
    y: scale.y(t),
    label: texts[k]?.text ?? '',
    chip: texts[k]?.chip ?? false,
  }));
  if (scale.infBand !== null)
    labels.push({ y: (scale.infBand.y0 + scale.infBand.y1) / 2, label: '+Inf', chip: false });
  drawAxes(i, plot, labels, false);
  let ts = h.timestamps;
  let counts = h.counts;
  let lastEnd: number | undefined;
  if (ts.length > columnCount(plot))
    ({ ts, counts, endMs: lastEnd } = mergeBuckets(ts, counts, nb, i.window, plot));
  let maxCount = 0;
  for (const c of counts) if (c > maxCount) maxCount = c;
  for (let t = 0; t < ts.length; t++) {
    const span = bucketSpan(plot, i.window, ts, t, lastEnd);
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
  drawChips(i, plot, labels);
  return {
    ...base,
    pick: { kind: 'heatmap', ref: h.timestamps, heatmap: h, scale, unit: spec.unit },
  };
}

function drawStat(i: LayerInput): LayerModel {
  const v = statValue(i.data);
  const plot = layoutPlot('stat', i.cssW, i.cssH, 0);
  const shown = Number.isFinite(v) ? v : null;
  const summary = frameSummary(
    'stat',
    i.window,
    plot,
    1,
    1,
    { min: shown, max: shown, last: shown },
    null,
  );
  const { ctx } = i;
  ctx.font = STAT_FONT;
  ctx.fillStyle = i.colours.text;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(formatValue(v, i.spec.unit), i.cssW / 2, i.cssH / 2);
  return { summary, pick: null, labelW: 0, valueDomain: null, bandHeld: false };
}

const seriesOf = (d: FrameData): readonly SeriesFrame[] => (d.kind === 'series' ? d.series : []);

/**
 * The band the layer would use for `i` ignoring `i.band`: max(widest full tick label,
 * `minValueBand`), computed as `drawLayer` computes it (bars run the same bucket merge). Paints
 * nothing; 0 for stat.
 */
export function measureValueBand(i: LayerInput): number {
  const m: LayerInput = { ...i, band: null };
  const { spec, data } = m;
  switch (spec.kind) {
    case 'line':
      return lineModel(m, seriesOf(data)).axis.labelW;
    case 'bars':
      return barsModel(m, spec, seriesOf(data)).axis.labelW;
    case 'heatmap':
      return heatmapAxis(m, data.kind === 'heatmap' ? data.heatmap : emptyHeatmap(), spec.unit)
        .width;
    case 'stat':
      return 0;
  }
}

/** The background and the marks of `spec`'s kind. */
export function drawLayer(i: LayerInput): LayerModel {
  i.ctx.fillStyle = i.colours.background;
  i.ctx.fillRect(0, 0, i.cssW, i.cssH);
  const { spec, data } = i;
  switch (spec.kind) {
    case 'line':
      return drawLine(i, seriesOf(data));
    case 'bars':
      return drawBars(i, spec, seriesOf(data));
    case 'heatmap':
      return drawHeatmap(i, spec, data.kind === 'heatmap' ? data.heatmap : emptyHeatmap());
    case 'stat':
      return drawStat(i);
  }
}

/** The crosshair, the hovered line values inside the plot and the brush band, over the layer. */
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
        const y = pick.y(r.value);
        // A manual value axis can leave a value outside the plot (#93): no dot there.
        if (!(y >= plot.y && y <= plot.y + plot.height)) continue;
        ctx.fillStyle = colours.series[r.colourIndex ?? 0] ?? '';
        ctx.beginPath();
        ctx.arc(hover.xCss, y, size['chart-line'] * 2, 0, 2 * Math.PI);
        ctx.fill();
      }
    }
  }
  if (brush !== null) {
    ctx.fillStyle = colours.brush;
    ctx.fillRect(Math.min(brush.x0, brush.x), plot.y, Math.abs(brush.x - brush.x0), plot.height);
  }
}
