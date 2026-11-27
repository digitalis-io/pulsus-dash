/**
 * The geomap's mark painter (T24-090, T24-091, T24-092; plan #234 Part 2 §4.7): symbols of equal
 * area, the group fill or the state fill, the pattern over it in `pattern-ink`, the state outline
 * and glyph (state is never colour alone, T02-004), the `surface-2` cluster discs with their counts
 * and worst-state chips, the labels, the selection's dimming and rings, the focus ring and the box
 * or brush band.
 */
import { font } from '../../../styles/tokens';
import { StateEncoding, type State } from '../../../theme/stateEncoding';
import type { GeoGroup } from '../../../vis/geo/frame';
import type { GeoFrame } from '../../../vis/geo/frame';
import type { GeoMapSpec, PlotRect } from '../../api';
import type { LabelBox, LaidMark, Placed } from '../../controller/geo/marks';
import type { Ctx2D } from '../ctx';
import type { ThemeColours } from '../palette';

export interface MarkPaint {
  readonly frame: GeoFrame;
  readonly spec: GeoMapSpec;
  readonly colours: ThemeColours;
  readonly pattern: (name: string) => CanvasPattern | null;
  /** The selected keys while the selection is relevant; null: nothing dims. */
  readonly selected: ReadonlySet<string> | null;
  readonly focusId: string | null;
}

/** At or above this radius the glyph sits inside the marker; below it, on a chip at its upper right. */
export const GLYPH_INSIDE_R = 8;
const CHIP_R = 5.5;
const RING_W = 2;
/** The selection ring sits just outside the mark; the focus ring at r + 3. */
const SELECT_GAP = 1;
const FOCUS_GAP = 3;
export const LABEL_FONT = `${String(font.size.xs)}px ${font.family.ui}`;
const COUNT_FONT = `${String(font.weight.semibold)} ${String(font.size.xs)}px ${font.family.ui}`;
const glyphFont = (px: number): string => `${String(Math.round(px))}px ${font.family.ui}`;

const STATE_OF_RANK: readonly (State | null)[] = [null, null, 'watch', 'degraded', 'failing'];

/** The path of `symbol` at (x, y) with the area of a circle of radius r. */
export function symbolPath(
  ctx: Ctx2D,
  symbol: GeoMapSpec['symbol'],
  x: number,
  y: number,
  r: number,
): void {
  ctx.beginPath();
  switch (symbol) {
    case 'circle':
      ctx.arc(x, y, r, 0, 2 * Math.PI);
      return;
    case 'square': {
      const s = (r * Math.sqrt(Math.PI)) / 2;
      ctx.moveTo(x - s, y - s);
      ctx.lineTo(x + s, y - s);
      ctx.lineTo(x + s, y + s);
      ctx.lineTo(x - s, y + s);
      break;
    }
    case 'triangle': {
      const a = r * Math.sqrt((4 * Math.PI) / Math.sqrt(3));
      const t = (a * Math.sqrt(3)) / 2;
      ctx.moveTo(x, y - (2 * t) / 3);
      ctx.lineTo(x + a / 2, y + t / 3);
      ctx.lineTo(x - a / 2, y + t / 3);
      break;
    }
    case 'diamond': {
      const d = r * Math.sqrt(Math.PI / 2);
      ctx.moveTo(x, y - d);
      ctx.lineTo(x + d, y);
      ctx.lineTo(x, y + d);
      ctx.lineTo(x - d, y);
      break;
    }
  }
  ctx.closePath();
}

const groupFill = (g: GeoGroup | undefined, c: ThemeColours): string =>
  g === undefined || g.colourIndex === null
    ? c.categoryOther
    : (c.series[g.colourIndex % c.series.length] ?? c.categoryOther);

/** A state glyph: inside at r ≥ 8 in `text`; else on a `surface-2` chip at the upper right. */
function glyph(
  ctx: Ctx2D,
  s: State,
  x: number,
  y: number,
  r: number,
  c: ThemeColours,
  ink: string,
): void {
  const g = StateEncoding[s].glyph;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (r >= GLYPH_INSIDE_R) {
    ctx.font = glyphFont(Math.max(8, r));
    ctx.fillStyle = ink;
    ctx.fillText(g, x, y);
    return;
  }
  const off = r * Math.SQRT1_2 + CHIP_R * 0.5;
  const cx = x + off;
  const cy = y - off;
  ctx.beginPath();
  ctx.arc(cx, cy, CHIP_R, 0, 2 * Math.PI);
  ctx.fillStyle = c.chip;
  ctx.fill();
  ctx.font = glyphFont(CHIP_R * 1.6);
  ctx.fillStyle = ink;
  ctx.fillText(g, cx, cy);
}

function paintMarker(ctx: Ctx2D, m: LaidMark, x: number, y: number, s: MarkPaint): void {
  const { frame, spec, colours: c } = s;
  const row = frame.rows[m.seed];
  if (row === undefined) return;
  const group = frame.groups[row.group];
  const state = row.state;
  const byState = spec.colour === 'state' && state !== null;
  symbolPath(ctx, spec.symbol, x, y, m.r);
  ctx.fillStyle = byState ? c.state[state] : groupFill(group, c);
  ctx.fill();
  if (frame.groups.length >= 2 && group !== undefined) {
    const p = s.pattern(group.pattern);
    if (p !== null) {
      ctx.fillStyle = p;
      ctx.fill();
    }
  }
  if (state === null) return;
  if (!byState) {
    ctx.strokeStyle = c.state[state];
    ctx.lineWidth = RING_W;
    ctx.stroke();
  }
  glyph(ctx, state, x, y, m.r, c, c.text);
}

function paintCluster(ctx: Ctx2D, m: LaidMark, x: number, y: number, s: MarkPaint): void {
  const c = s.colours;
  ctx.beginPath();
  ctx.arc(x, y, m.r, 0, 2 * Math.PI);
  ctx.fillStyle = c.chip;
  ctx.fill();
  ctx.strokeStyle = c.grid;
  ctx.lineWidth = 0.5;
  ctx.stroke();
  ctx.font = COUNT_FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = c.text;
  ctx.fillText(String(m.keys.length), x, y);
  const worst = STATE_OF_RANK[m.rank] ?? null;
  if (worst === null) return;
  // The worst state's chip: its glyph in its colour, encoded twice.
  const off = m.r * Math.SQRT1_2;
  ctx.beginPath();
  ctx.arc(x + off, y - off, CHIP_R + 1, 0, 2 * Math.PI);
  ctx.fillStyle = c.background;
  ctx.fill();
  ctx.strokeStyle = c.state[worst];
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.font = glyphFont(CHIP_R * 1.6);
  ctx.fillStyle = c.state[worst];
  ctx.fillText(StateEncoding[worst].glyph, x + off, y - off);
}

function ring(ctx: Ctx2D, x: number, y: number, r: number, colour: string): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, 2 * Math.PI);
  ctx.strokeStyle = colour;
  ctx.lineWidth = RING_W;
  ctx.stroke();
}

/** Paints `p` (draw order) at `alpha` (a crossfade's share): marks, then selection and focus rings. */
export function paintMarks(ctx: Ctx2D, p: Placed, alpha: number, s: MarkPaint): void {
  const c = s.colours;
  const sel = s.selected;
  for (let i = 0; i < p.marks.length; i++) {
    const m = p.marks[i];
    const x = p.x[i] ?? NaN;
    const y = p.y[i] ?? NaN;
    if (m === undefined) continue;
    const match = sel !== null && m.keys.some((k) => sel.has(k));
    ctx.globalAlpha = alpha * (sel !== null && !match ? c.dimmed : 1);
    if (m.kind === 'cluster') paintCluster(ctx, m, x, y, s);
    else paintMarker(ctx, m, x, y, s);
    ctx.globalAlpha = alpha;
    if (match) ring(ctx, x, y, m.r + SELECT_GAP, c.focus);
    if (m.id === s.focusId) ring(ctx, x, y, m.r + FOCUS_GAP, c.focus);
  }
  ctx.globalAlpha = 1;
}

/** The marker names, left-aligned and vertically centred in their boxes. */
export function paintLabels(ctx: Ctx2D, labels: readonly LabelBox[], c: ThemeColours): void {
  if (labels.length === 0) return;
  ctx.font = LABEL_FONT;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = c.text;
  for (const l of labels) ctx.fillText(l.text, l.x, l.y + l.height / 2);
}

/** The box or brush band. */
export function paintBand(ctx: Ctx2D, box: PlotRect, c: ThemeColours): void {
  ctx.fillStyle = c.brush;
  ctx.fillRect(box.x, box.y, box.width, box.height);
}
