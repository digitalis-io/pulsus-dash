/**
 * The Canvas 2D bar chart (ADR-0028, plan #173 Part 2 §4.2): one bar per `categories` row in data
 * order, laid out by `barLayout`, with the value axis, the names (state glyph first), the value
 * labels outside the bars, the threshold lines with their glyphs, the baseline ghost and the
 * selection; and its overlay (ADR-0029): the keyboard focus mark and the brush band. Colours come
 * from `ThemeColours` only: the state colour of a row with a state, else
 * its own series colour (T22-004); no gradient, pattern or shadow (T22-001). The layer returns the
 * bands that `mark` and `pick` hit; the frame copies the data's coverage into the summary.
 */
import { size, space } from '../../styles/tokens';
import { formatCompact, formatValue, tickBase } from '../../i18n/format';
import { StateEncoding } from '../../theme/stateEncoding';
import type {
  BarchartSpec,
  CategoryRow,
  Coverage,
  FrameSummary,
  HoverRow,
  PlotRect,
  ThresholdLabelBox,
  ValueRange,
} from '../api';
import type { BarOverlay } from './barInput';
import { barLayout, valueText, type BarLayout } from './barLayout';
import type { Ctx2D } from './ctx';
import type { LayerInput, LayerModel } from './draw';
import { AXIS_FONT, BAR_VALUE_BAND, EVENT_BAND, LABEL_HEIGHT } from './layout';
import { seriesColourIndex, type ThemeColours } from './palette';
import { drawFocusRing, matchedKeys } from './selection';
import { frameSummary } from './summary';
import { fitText } from './text';
import { thresholdsOf } from './thresholdMark';
import { tickY, valueFraction, valueTicks } from './valueTicks';

/** A drawn bar's band, for picking: the category interval [lo, hi) and the value end. */
export interface BarHit {
  readonly key: string;
  readonly index: number;
  /** Along the category axis (CSS px). */
  readonly lo: number;
  readonly hi: number;
  /** The bar's value end and band centre (`MarkEvent`). */
  readonly xCss: number;
  readonly yCss: number;
  readonly row: HoverRow;
}

/** What `mark` and `pick` need from the last barchart layer. */
export interface BarPick {
  readonly kind: 'barchart';
  /** Always empty: a bar chart has no time axis, so the crosshair keys find nothing. */
  readonly ref: Float64Array;
  readonly horizontal: boolean;
  /** Where a pointer hits a band: the name band and the plot, across the category axis. */
  readonly area: PlotRect;
  /** The plot: the brush band spans it across the category axis (ADR-0029). */
  readonly plot: PlotRect;
  readonly bands: readonly BarHit[];
}

/** The smallest gap between horizontal value-axis tick labels (CSS px). */
const H_TICK_GAP = 72;

const NO_REF = new Float64Array(0);

/** The value domain and its ticks: the manual range, else auto with 0 and the thresholds. */
function valueDomain(
  spec: BarchartSpec,
  rows: readonly CategoryRow[],
  plot: PlotRect,
): { domain: ValueRange; ticks: readonly number[] } {
  const horizontal = spec.orientation === 'horizontal';
  const length = horizontal ? plot.width : plot.height;
  const gap = horizontal ? H_TICK_GAP : LABEL_HEIGHT;
  const base = tickBase(spec.unit);
  const r = spec.valueRange;
  if (r !== undefined) {
    const tol = 1e-9 * (r.max - r.min);
    const ticks = valueTicks(r.min, r.max, length, gap, base).ticks.filter(
      (t) => t >= r.min - tol && t <= r.max + tol,
    );
    return { domain: r, ticks };
  }
  let lo = 0;
  let hi = 0;
  for (const row of rows) {
    if (!Number.isFinite(row.value)) continue;
    lo = Math.min(lo, row.value);
    hi = Math.max(hi, row.value);
  }
  for (const l of thresholdsOf(spec)) {
    if (!Number.isFinite(l.value)) continue;
    lo = Math.min(lo, l.value);
    hi = Math.max(hi, l.value);
  }
  const vt = valueTicks(lo, hi, length, gap, base);
  return { domain: { min: vt.min, max: vt.max }, ticks: vt.ticks };
}

/** The finite min and max of the drawn rows. */
function drawnStats(rows: readonly CategoryRow[]): { min: number | null; max: number | null } {
  let min = Infinity;
  let max = -Infinity;
  for (const r of rows) {
    if (!Number.isFinite(r.value)) continue;
    min = Math.min(min, r.value);
    max = Math.max(max, r.value);
  }
  return min === Infinity ? { min: null, max: null } : { min, max };
}

/** The grid hairlines and the tick labels of the value axis. */
function drawValueAxis(
  i: LayerInput,
  spec: BarchartSpec,
  plot: PlotRect,
  ticks: readonly number[],
  pos: (v: number) => number,
): void {
  const { ctx, colours } = i;
  ctx.font = AXIS_FONT;
  ctx.fillStyle = colours.grid;
  const horizontal = spec.orientation === 'horizontal';
  for (const t of ticks) {
    const at = Math.round(pos(t));
    if (horizontal) ctx.fillRect(at, plot.y, 1, plot.height);
    else ctx.fillRect(plot.x, at, plot.width, 1);
  }
  ctx.fillStyle = colours.axisText;
  if (horizontal) {
    const bottom = plot.y + plot.height;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const t of ticks) {
      ctx.fillRect(Math.round(pos(t)), bottom, 1, size['chart-tick']);
      ctx.fillText(formatValue(t, spec.unit), pos(t), bottom + size['chart-tick'] + space['1']);
    }
    return;
  }
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const x = plot.x - size['chart-tick'] - space['1'];
  for (const t of ticks) {
    const compact = formatCompact(t, spec.unit);
    const text =
      ctx.measureText(compact).width <= BAR_VALUE_BAND
        ? compact
        : (fitText(ctx, compact, BAR_VALUE_BAND) ?? '');
    if (text !== '') ctx.fillText(text, x, pos(t));
  }
}

/**
 * The threshold lines across the value axis, dashed in their state colour, and their glyphs in
 * the row above the plot (H) or the column right of it (V). Returns the glyph boxes, whose full
 * text the DOM shows (`clipped`).
 */
function drawBarThresholds(
  i: LayerInput,
  spec: BarchartSpec,
  plot: PlotRect,
  domain: ValueRange,
  pos: (v: number) => number,
): ThresholdLabelBox[] {
  const { ctx, colours } = i;
  const horizontal = spec.orientation === 'horizontal';
  const boxes: ThresholdLabelBox[] = [];
  for (const l of thresholdsOf(spec)) {
    if (!Number.isFinite(l.value) || l.value < domain.min || l.value > domain.max) continue;
    const at = Math.round(pos(l.value)) + 0.5;
    ctx.save();
    ctx.strokeStyle = colours.state[l.state];
    ctx.lineWidth = 1;
    ctx.setLineDash([size['chart-dash'], size['chart-dash-gap']]);
    ctx.beginPath();
    if (horizontal) {
      ctx.moveTo(at, plot.y);
      ctx.lineTo(at, plot.y + plot.height);
    } else {
      ctx.moveTo(plot.x, at);
      ctx.lineTo(plot.x + plot.width, at);
    }
    ctx.stroke();
    ctx.restore();
    const glyph = StateEncoding[l.state].glyph;
    ctx.font = AXIS_FONT;
    const w = ctx.measureText(glyph).width;
    const box: PlotRect = horizontal
      ? { x: at - w / 2, y: plot.y - EVENT_BAND, width: w, height: LABEL_HEIGHT }
      : {
          x: plot.x + plot.width + space['1'],
          y: at - LABEL_HEIGHT / 2,
          width: w,
          height: LABEL_HEIGHT,
        };
    ctx.fillStyle = colours.stateText[l.state];
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(glyph, box.x, box.y + LABEL_HEIGHT / 2);
    boxes.push({ box, text: `${glyph} ${l.label}`, clipped: true });
  }
  return boxes;
}

/** A row's name (and state glyph) in the name band; a lone glyph when the names are hidden. */
function drawName(
  i: LayerInput,
  spec: BarchartSpec,
  lay: BarLayout,
  plot: PlotRect,
  r: CategoryRow,
  label: string | null,
  centre: number,
): void {
  const { ctx, colours } = i;
  const glyph = r.state === null ? null : StateEncoding[r.state].glyph;
  const ink = r.state === null ? null : colours.stateText[r.state];
  ctx.textBaseline = 'middle';
  if (spec.orientation === 'horizontal') {
    if (label === null) {
      if (glyph === null || ink === null) return;
      ctx.fillStyle = ink;
      ctx.textAlign = 'center';
      ctx.fillText(glyph, lay.band / 2, centre);
      return;
    }
    const right = lay.band - space['1'];
    ctx.fillStyle = colours.axisText;
    ctx.textAlign = 'right';
    ctx.fillText(label, right, centre);
    if (glyph === null || ink === null) return;
    ctx.fillStyle = ink;
    ctx.textAlign = 'left';
    ctx.fillText(glyph, right - ctx.measureText(label).width - lay.glyphW, centre);
    return;
  }
  const top = plot.y + plot.height + lay.valueRooms[0];
  if (label === null) {
    if (glyph === null || ink === null) return;
    ctx.fillStyle = ink;
    ctx.textAlign = 'center';
    ctx.fillText(glyph, centre, top + lay.band / 2);
    return;
  }
  ctx.save();
  ctx.translate(centre, top + space['1']);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = colours.axisText;
  ctx.textAlign = 'right';
  ctx.fillText(label, 0, 0);
  if (glyph !== null && ink !== null) {
    ctx.fillStyle = ink;
    ctx.textAlign = 'left';
    ctx.fillText(glyph, -ctx.measureText(label).width - lay.glyphW, 0);
  }
  ctx.restore();
}

/** A row's value label past its bar end, outside the bar (`no data` for a non-finite value). */
function drawValueLabel(
  i: LayerInput,
  spec: BarchartSpec,
  r: CategoryRow,
  end: number,
  centre: number,
): void {
  const { ctx, colours } = i;
  const negative = r.value < 0;
  ctx.fillStyle = colours.axisText;
  const text = valueText(r, spec);
  if (spec.orientation === 'horizontal') {
    ctx.textBaseline = 'middle';
    ctx.textAlign = negative ? 'right' : 'left';
    ctx.fillText(text, negative ? end - space['1'] : end + space['1'], centre);
    return;
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = negative ? 'top' : 'bottom';
  ctx.fillText(text, centre, negative ? end + space['1'] : end - space['1']);
}

export function drawBarchart(
  i: LayerInput,
  spec: BarchartSpec,
  rows: readonly CategoryRow[],
  coverage: Coverage,
): LayerModel {
  const { ctx, colours } = i;
  ctx.font = AXIS_FONT;
  const lay = barLayout(spec, rows, i.cssW, i.cssH, (s) => ctx.measureText(s).width);
  const { plot } = lay;
  const horizontal = spec.orientation === 'horizontal';
  const { domain, ticks } = valueDomain(spec, rows, plot);
  const base = frameSummary(
    'barchart',
    i.window,
    plot,
    coverage.total,
    coverage.drawn,
    { ...drawnStats(rows), last: null },
    { min: domain.min, max: domain.max, manual: spec.valueRange !== undefined },
  );
  const flags: Pick<FrameSummary, 'namesHidden' | 'valuesHidden'> = {
    ...(lay.names === null ? { namesHidden: true } : {}),
    ...(spec.valueLabels ? {} : { valuesHidden: true }),
  };
  const area: PlotRect = horizontal
    ? { x: 0, y: plot.y, width: plot.x + plot.width, height: plot.height }
    : { x: plot.x, y: plot.y, width: plot.width, height: i.cssH - plot.y };
  const bands: BarHit[] = [];
  const model = (summary: FrameSummary): LayerModel => ({
    summary: { ...summary, coverage, ...flags },
    pick: { kind: 'barchart', ref: NO_REF, horizontal, area, plot, bands },
    labelW: 0,
    valueDomain: null,
    bandHeld: false,
  });
  if (!(plot.width > 0) || !(plot.height > 0)) return model(base);
  const pos = (v: number): number =>
    horizontal
      ? plot.x + valueFraction(v, domain.min, domain.max) * plot.width
      : tickY(v, domain.min, domain.max, plot.y, plot.height);
  const clamp = (v: number): number => Math.min(domain.max, Math.max(domain.min, v));
  drawValueAxis(i, spec, plot, ticks, pos);
  const n = rows.length;
  const extent = horizontal ? plot.height : plot.width;
  const start = horizontal ? plot.y : plot.x;
  const step = n > 0 ? extent / n : 0;
  const thick = Math.max(1, Math.round(0.7 * step));
  const zero = pos(clamp(0));
  const matched = matchedKeys(
    i.selection,
    rows.map((r) => r.key),
  );
  rows.forEach((r, k) => {
    const lo = start + k * step;
    const c0 = Math.round(lo + (step - thick) / 2);
    const finite = Number.isFinite(r.value);
    const end = finite ? pos(clamp(r.value)) : zero;
    const centre = c0 + thick / 2;
    const colourIndex = r.state === null ? seriesColourIndex(r) : null;
    bands.push({
      key: r.key,
      index: k,
      lo,
      hi: lo + step,
      xCss: horizontal ? end : centre,
      yCss: horizontal ? centre : end,
      row: { key: r.key, name: r.name, colourIndex, value: r.value },
    });
    // T25-006: with a relevant selection the others are dimmed; with none, alpha is untouched.
    const hit = matched?.has(r.key) === true;
    if (matched !== null) ctx.globalAlpha = hit ? 1 : colours.dimmed;
    const rect = horizontal
      ? { x: Math.min(zero, end), y: c0, w: Math.abs(end - zero), h: thick }
      : { x: c0, y: Math.min(zero, end), w: thick, h: Math.abs(zero - end) };
    if (finite) {
      ctx.fillStyle =
        r.state === null ? (colours.series[colourIndex ?? 0] ?? '') : colours.state[r.state];
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      if (hit) drawFocusRing(ctx, colours, rect.x, rect.y, rect.w, rect.h);
    }
    if (spec.ghost && r.baseline !== null && Number.isFinite(r.baseline)) {
      const b = pos(clamp(r.baseline));
      ctx.save();
      ctx.setLineDash([size['chart-dash'], size['chart-dash-gap']]);
      ctx.strokeStyle = colours.ghost;
      ctx.lineWidth = 1;
      if (horizontal) ctx.strokeRect(Math.min(zero, b), c0, Math.abs(b - zero), thick);
      else ctx.strokeRect(c0, Math.min(zero, b), thick, Math.abs(zero - b));
      ctx.restore();
    }
    ctx.font = AXIS_FONT;
    drawName(i, spec, lay, plot, r, lay.names?.[k] ?? null, centre);
    if (spec.valueLabels) drawValueLabel(i, spec, r, end, centre);
  });
  if (matched !== null) ctx.globalAlpha = 1;
  const thresholdLabels = drawBarThresholds(i, spec, plot, domain, pos);
  return model({ ...base, thresholdLabels });
}

/** The band under `p` (inside the name band or the plot), or null. */
export function barAt(pick: BarPick, p: { x: number; y: number }): BarHit | null {
  const a = pick.area;
  if (!(p.x >= a.x && p.x < a.x + a.width && p.y >= a.y && p.y < a.y + a.height)) return null;
  const c = pick.horizontal ? p.y : p.x;
  for (const b of pick.bands) if (c >= b.lo && c < b.hi) return b;
  return null;
}

/** The band at draw index `i`, or null (ADR-0029: the keyboard focus and the Shift brush). */
export function barByIndex(pick: BarPick, i: number): BarHit | null {
  return pick.bands[i] ?? null;
}

/**
 * The draw index of the band at `p` along the category axis, clamped to the drawn bands (the
 * pointer brush, ADR-0029); null when no band is drawn.
 */
export function bandIndexAt(pick: BarPick, p: { x: number; y: number }): number | null {
  const n = pick.bands.length;
  const first = pick.bands[0];
  const last = pick.bands[n - 1];
  if (first === undefined || last === undefined) return null;
  const c = pick.horizontal ? p.y : p.x;
  if (c < first.lo) return 0;
  if (c >= last.hi) return n - 1;
  const i = pick.bands.findIndex((b) => c >= b.lo && c < b.hi);
  return i < 0 ? n - 1 : i;
}

/**
 * The bar chart's overlay (ADR-0029), drawn on the visible canvas after the layer: the brushed
 * bands filled with `selection` across the plot, and a 2 px `focus` stroke around the keyboard
 * focus band, from the name band's left edge to the plot's right edge (H) or from the plot top to
 * the name band's bottom (V).
 */
export function drawBarOverlay(
  ctx: Ctx2D,
  pick: BarPick,
  colours: ThemeColours,
  o: BarOverlay,
): void {
  const { plot, area } = pick;
  if (o.brush !== null) {
    const a = barByIndex(pick, o.brush.lo);
    const b = barByIndex(pick, o.brush.hi);
    if (a !== null && b !== null) {
      ctx.fillStyle = colours.selection;
      if (pick.horizontal) ctx.fillRect(plot.x, a.lo, plot.width, b.hi - a.lo);
      else ctx.fillRect(a.lo, plot.y, b.hi - a.lo, plot.height);
    }
  }
  const f = o.focus === null ? null : barByIndex(pick, o.focus);
  if (f === null) return;
  ctx.save();
  ctx.strokeStyle = colours.focus;
  ctx.lineWidth = 2;
  if (pick.horizontal) ctx.strokeRect(area.x, f.lo, area.width, f.hi - f.lo);
  else ctx.strokeRect(f.lo, area.y, f.hi - f.lo, area.height);
  ctx.restore();
}
