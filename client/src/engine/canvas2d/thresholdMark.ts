/**
 * The threshold mark of line and bars (plan #64 Part B §4.2, ADR-0022), split from `draw.ts`,
 * which calls it after the series and re-exports `withThresholds` and `layoutThresholdLabels`:
 * dashed lines in their state colour (from `StateEncoding` through `ThemeColours.state`, T02-004),
 * and labels that are stacked, truncated or gathered into an overflow chip, but never dropped.
 */
import { border, size, space } from '../../styles/tokens';
import { StateEncoding } from '../../theme/stateEncoding';
import type { PlotRect, ThresholdLabelBox, ThresholdLine, ThresholdState, VisSpec } from '../api';
import type { Ctx2D } from './ctx';
import type { LayerInput } from './draw';
import { AXIS_FONT, LABEL_HEIGHT } from './layout';
import { truncated } from './text';

/** The most threshold lines a frame draws, in spec order (ADR-0022). */
const MAX_THRESHOLDS = 8;

/** The threshold lines of a line, bars or barchart spec that are drawn: the first 8, in order. */
export function thresholdsOf(spec: VisSpec): readonly ThresholdLine[] {
  return spec.kind === 'line' || spec.kind === 'bars' || spec.kind === 'barchart'
    ? (spec.thresholds ?? []).slice(0, MAX_THRESHOLDS)
    : [];
}

/** [min, max] widened to every finite threshold value; [0, 0] when no input is finite. */
export function withThresholds(
  min: number | null,
  max: number | null,
  t: readonly ThresholdLine[] | undefined,
): { min: number; max: number } {
  let lo = min !== null && Number.isFinite(min) ? min : Infinity;
  let hi = max !== null && Number.isFinite(max) ? max : -Infinity;
  for (const l of t ?? []) {
    if (!Number.isFinite(l.value)) continue;
    if (l.value < lo) lo = l.value;
    if (l.value > hi) hi = l.value;
  }
  return lo === Infinity || hi === -Infinity ? { min: 0, max: 0 } : { min: lo, max: hi };
}

/** A laid-out threshold label: what `layoutThresholdLabels` returns. */
type LaidOutLabel = ThresholdLabelBox & {
  /** The text painted: whole, truncated with `…`, the glyph alone, or `+N`. */
  readonly drawn: string;
  /** null for the overflow chip. */
  readonly state: ThresholdState | null;
  /** The line's y inside the plot; null when the line is off-axis (or for the chip). */
  readonly lineY: number | null;
};

interface PendingLabel {
  readonly desired: number;
  readonly text: string;
  readonly drawn: string;
  readonly clipped: boolean;
  readonly width: number;
  readonly state: ThresholdState | null;
  readonly lineY: number | null;
  /** Where an off-axis line is: the leader goes to that plot edge. */
  readonly edge: number | null;
  top: number;
}

/** Steps 4–5 of the layout: the forward pass, then the whole-box backward shift at the bottom. */
function stack(items: PendingLabel[], plot: PlotRect): void {
  const h = LABEL_HEIGHT;
  const g = space['1'];
  items.forEach((it, k) => {
    const prev = items[k - 1];
    it.top =
      prev === undefined ? Math.max(it.desired, plot.y) : Math.max(it.desired, prev.top + h + g);
  });
  const bottom = plot.y + plot.height;
  const last = items.at(-1);
  if (last === undefined || last.top + h <= bottom) return;
  last.top = bottom - h;
  for (let k = items.length - 2; k >= 0; k--) {
    const it = items[k];
    const next = items[k + 1];
    if (it === undefined || next === undefined) break;
    const top = Math.min(it.top, next.top - g - h);
    if (top === it.top) break;
    it.top = top;
  }
}

/** The labels of `layoutThresholdLabels` with their desired tops and leader edges, in stack order. */
function placeThresholdLabels(
  ctx: Ctx2D,
  plot: PlotRect,
  y: (v: number) => number,
  lines: readonly ThresholdLine[],
): PendingLabel[] {
  const h = LABEL_HEIGHT;
  const g = space['1'];
  const pad = space['1'];
  const bottom = plot.y + plot.height;
  const maxW = Math.max(0, Math.min(plot.width - 2 * space['2'], Math.round(plot.width / 2)));
  ctx.font = AXIS_FONT;
  const items: PendingLabel[] = [];
  for (const l of lines) {
    if (!Number.isFinite(l.value)) continue;
    const glyph = StateEncoding[l.state].glyph;
    const text = `${glyph} ${l.label}`;
    const ly = y(l.value);
    let desired: number;
    let lineY: number | null = null;
    let edge: number | null = null;
    if (ly < plot.y) {
      desired = plot.y;
      edge = plot.y;
    } else if (ly > bottom) {
      desired = bottom - h;
      edge = bottom;
    } else {
      lineY = ly;
      desired = ly - g - h < plot.y ? ly + g : ly - g - h;
    }
    const room = maxW - 2 * pad;
    const fits = ctx.measureText(text).width <= room;
    const drawn = fits ? text : truncated(ctx, text, room);
    const width = ctx.measureText(drawn).width + 2 * pad;
    items.push({
      desired,
      text,
      drawn,
      clipped: !fits,
      width,
      state: l.state,
      lineY,
      edge,
      top: 0,
    });
  }
  // Stable: ties keep spec order.
  items.sort((a, b) => a.desired - b.desired);
  stack(items, plot);
  let placed = items;
  const first = items[0];
  if (first !== undefined && first.top < plot.y) {
    const n = Math.floor((plot.height + g) / (h + g));
    const kept = items.slice(0, Math.max(0, n - 1));
    const hidden = items.slice(Math.max(0, n - 1));
    const chipText = `+${String(hidden.length)}`;
    const chip: PendingLabel | null =
      n <= 0 || hidden[0] === undefined
        ? null
        : {
            desired: hidden[0].desired,
            text: hidden.map((x) => x.text).join('; '),
            drawn: chipText,
            clipped: true,
            width: ctx.measureText(chipText).width + 2 * pad,
            state: null,
            lineY: null,
            edge: null,
            top: 0,
          };
    placed = chip === null ? [] : [...kept, chip].sort((a, b) => a.desired - b.desired);
    stack(placed, plot);
  }
  return placed;
}

/** The box of a placed label (CSS px relative to the canvas). */
const boxOf = (plot: PlotRect, it: PendingLabel): PlotRect => ({
  x: plot.x + space['2'],
  y: it.top,
  width: it.width,
  height: LABEL_HEIGHT,
});

/**
 * Lays out the threshold labels (plan #64 Part B §4.2) without painting: one box per label of a
 * finite line, drawn or not, each `LABEL_HEIGHT` tall, stacked so none overlaps, shifted up whole
 * at the bottom edge, and the ones that cannot fit gathered into one `+N` chip. In stack order.
 */
export function layoutThresholdLabels(
  ctx: Ctx2D,
  plot: PlotRect,
  y: (v: number) => number,
  lines: readonly ThresholdLine[],
): readonly LaidOutLabel[] {
  return placeThresholdLabels(ctx, plot, y, lines).map((it) => ({
    box: boxOf(plot, it),
    text: it.text,
    clipped: it.clipped,
    drawn: it.drawn,
    state: it.state,
    lineY: it.lineY,
  }));
}

/**
 * The threshold mark (§4.2): each drawn line whose value maps inside the plot, dashed in its state
 * colour, then every label on a chip in its state text colour (#284), with a 1 px leader in the state
 * colour from a label that was moved (or whose line is off-axis) to its line (or the plot edge).
 * Returns the label boxes.
 */
export function drawThresholds(
  i: LayerInput,
  plot: PlotRect,
  y: (v: number) => number,
  lines: readonly ThresholdLine[],
): readonly ThresholdLabelBox[] {
  if (lines.length === 0) return [];
  const { ctx, colours } = i;
  const bottom = plot.y + plot.height;
  for (const l of lines) {
    if (!Number.isFinite(l.value)) continue;
    const ly = y(l.value);
    if (!(ly >= plot.y && ly <= bottom)) continue;
    const at = Math.round(ly) + 0.5;
    ctx.save();
    ctx.strokeStyle = colours.state[l.state];
    ctx.lineWidth = border.hairline;
    ctx.setLineDash([size['chart-dash'], size['chart-dash-gap']]);
    ctx.beginPath();
    ctx.moveTo(plot.x, at);
    ctx.lineTo(plot.x + plot.width, at);
    ctx.stroke();
    ctx.restore();
  }
  const placed = placeThresholdLabels(ctx, plot, y, lines);
  const pad = space['1'];
  ctx.font = AXIS_FONT;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (const it of placed) {
    const b = boxOf(plot, it);
    const mid = b.y + b.height / 2;
    const ink = it.state === null ? colours.axisText : colours.stateText[it.state];
    const target = it.lineY ?? it.edge;
    if (it.state !== null && target !== null && (it.top !== it.desired || it.lineY === null)) {
      ctx.strokeStyle = colours.state[it.state];
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(plot.x + pad, mid);
      ctx.lineTo(plot.x + pad, target);
      ctx.stroke();
    }
    ctx.fillStyle = colours.chip;
    ctx.fillRect(b.x, b.y, b.width, b.height);
    ctx.fillStyle = ink;
    ctx.fillText(it.drawn, b.x + pad, mid);
  }
  return placed.map((it) => ({ box: boxOf(plot, it), text: it.text, clipped: it.clipped }));
}
