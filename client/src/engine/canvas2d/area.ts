/**
 * The line area (#282 Part 2b §3.4, §4.2; ADR-0036): a vertical gradient under each series' joins,
 * `opacity.chart-area` ÷ shown at the plot's top to 0 at its bottom, for 1–4 series and no
 * selection, before any stroke.
 *
 * The piecewise edge rule (`areaPieces`, mirrored by the engine's `area.wgsl` and checked against
 * the same `engine/fixtures/area-pieces.json`): a join's span splits where the line crosses the
 * plot's top and bottom; above the plot the area fills from the top, inside from the line, below
 * not at all. Canvas 2D never projects an out-of-range value: the ends are classed in value space
 * against the axis [min, max], the crossings are cut parameters on the original line (halved when
 * the difference overflows, as the engine's `encode.rs` `cut`), and only in-range values and the
 * crossing points are projected, fraction first (`tickY`), so every coordinate is finite.
 */
import { opacity } from '../../styles/tokens';
import type { SeriesFrame } from '../../data/frames';
import type { FrameSelection, PlotRect, TimeWindow, ValueRange, VisSpec } from '../api';
import { lineColumns, type Column } from './columns';
import type { Ctx2D } from './ctx';
import { withAlpha } from './palette';
import { tickY } from './valueTicks';

/** One piece over [x0, x1]; the area's top edge runs from (x0, y0) to (x1, y1), CSS px. */
export interface AreaPiece {
  /** Above the plot (filled from the top), inside (from the line) or below (not filled). */
  readonly cls: 'A' | 'I' | 'B';
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
}

/** The parameter t ∈ [0, 1] where the segment va → vb reaches `c`; halved when vb − va overflows. */
export function cut(c: number, va: number, vb: number): number {
  const d = vb - va;
  return Number.isFinite(d) ? (c - va) / d : (c / 2 - va / 2) / (vb / 2 - va / 2);
}

/**
 * The pieces of the join from value `va` at x0 to `vb` at x1 (both finite) on the axis [min, max]
 * drawn over rows top … top + height. Empty when x1 ≤ x0.
 */
export function areaPieces(
  x0: number,
  x1: number,
  va: number,
  vb: number,
  min: number,
  max: number,
  top: number,
  height: number,
): AreaPiece[] {
  if (!(x1 > x0)) return [];
  const bottom = top + height;
  const cls = (v: number): AreaPiece['cls'] => (v > max ? 'A' : v < min ? 'B' : 'I');
  const y = (v: number): number => tickY(v, min, max, top, height);
  const edge = (k: AreaPiece['cls']): number => (k === 'A' ? top : bottom);
  const ca = cls(va);
  const cb = cls(vb);
  const cuts: { x: number; y: number; next: AreaPiece['cls'] }[] = [];
  const at = (c: number, yc: number, next: AreaPiece['cls']): void => {
    const prev = cuts.at(-1)?.x ?? x0;
    const x = Math.min(x1, Math.max(prev, x0 + cut(c, va, vb) * (x1 - x0)));
    cuts.push({ x, y: yc, next });
  };
  if (vb > va) {
    if (ca === 'B' && cb !== 'B') at(min, bottom, 'I');
    if (cb === 'A' && ca !== 'A') at(max, top, 'A');
  } else {
    if (ca === 'A' && cb !== 'A') at(max, top, 'I');
    if (cb === 'B' && ca !== 'B') at(min, bottom, 'B');
  }
  const pieces: AreaPiece[] = [];
  let k = ca;
  let x = x0;
  let ys = ca === 'I' ? y(va) : edge(ca);
  for (const c of cuts) {
    const y1 = k === 'I' ? c.y : edge(k);
    pieces.push({ cls: k, x0: x, x1: c.x, y0: k === 'I' ? ys : edge(k), y1 });
    k = c.next;
    x = c.x;
    ys = c.y;
  }
  const ye = k === 'I' ? y(vb) : edge(k);
  pieces.push({ cls: k, x0: x, x1, y0: k === 'I' ? ys : edge(k), y1: ye });
  return pieces;
}

/**
 * The area polygons of one series: a polygon per run of consecutive joins the line does not break
 * (a NaN before a column's first sample ends it, one inside a column too), from the first join's x
 * at the bottom along the pieces' top edges back to the bottom at the last join's x.
 */
export function areaPolygons(
  cols: readonly (Column | null)[],
  plot: PlotRect,
  domain: { readonly min: number; readonly max: number },
): (readonly [number, number])[][] {
  const bottom = plot.y + plot.height;
  const out: (readonly [number, number])[][] = [];
  let poly: [number, number][] | null = null;
  let lastX = 0;
  const close = (): void => {
    if (poly === null) return;
    poly.push([lastX, bottom]);
    out.push(poly);
    poly = null;
  };
  let prev: Column | null = null;
  for (const c of cols) {
    if (c === null) continue;
    const p = prev;
    prev = c;
    if (p === null) continue;
    if (c.gapLead || p.gapInner) close();
    if (c.gapLead) continue;
    const x0 = plot.x + p.x + 0.5;
    const x1 = plot.x + c.x + 0.5;
    const pieces = areaPieces(x0, x1, p.last, c.first, domain.min, domain.max, plot.y, plot.height);
    if (pieces.length === 0) continue;
    poly ??= [[x0, bottom]];
    for (const s of pieces) poly.push([s.x0, s.y0], [s.x1, s.y1]);
    lastX = x1;
  }
  close();
  return out;
}

/** Fills one series' area polygons with the vertical gradient (nothing when it has no join). */
export function fillArea(
  ctx: Ctx2D,
  cols: readonly (Column | null)[],
  plot: PlotRect,
  domain: { readonly min: number; readonly max: number },
  colour: string,
  alphaTop: number,
): void {
  const polys = areaPolygons(cols, plot, domain);
  if (polys.length === 0) return;
  const bottom = plot.y + plot.height;
  const g = ctx.createLinearGradient(0, plot.y, 0, bottom);
  g.addColorStop(0, withAlpha(colour, alphaTop));
  g.addColorStop(1, withAlpha(colour, 0));
  ctx.beginPath();
  for (const poly of polys) {
    poly.forEach(([x, y], k) => {
      if (k === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
  }
  ctx.fillStyle = g;
  ctx.fill();
}

/** The most series a line area is drawn under (ADR-0036). */
const MAX_AREA_SERIES = 4;

/** Any selection at all: keys or an interval, matched or not (ADR-0036). */
export function hasSelection(sel: FrameSelection | null | undefined): boolean {
  return (
    sel !== null &&
    sel !== undefined &&
    (sel.keys.length > 0 || sel.fromMs !== null || sel.toMs !== null)
  );
}

/**
 * ADR-0036: every shown series' area, clipped to the plot, before any stroke: when the spec asks
 * for it, 1–4 series are shown and there is no selection; each at `chart-area` ÷ shown.
 */
export function drawAreas(
  ctx: Ctx2D,
  spec: VisSpec,
  selection: FrameSelection | null | undefined,
  shown: readonly SeriesFrame[],
  window: TimeWindow,
  plot: PlotRect,
  domain: ValueRange,
  colourOf: (s: SeriesFrame) => string,
): void {
  if (spec.kind !== 'line' || spec.area !== true) return;
  if (shown.length < 1 || shown.length > MAX_AREA_SERIES || hasSelection(selection)) return;
  const alpha = opacity['chart-area'] / shown.length;
  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.x, plot.y, plot.width, plot.height);
  ctx.clip();
  for (const s of shown) {
    const cols = lineColumns(s.timestamps, s.values, window, plot);
    fillArea(ctx, cols, plot, domain, colourOf(s), alpha);
  }
  ctx.restore();
}
