/**
 * Click picking (ADR-0025, T25-005, plan #192 §4.3): the mark under a click on the plot, from the
 * last layer draw. Line: the hover row nearest the pointer's y at the snapped time (ties: earlier
 * draw order); bars: the stacked segment of the drawn (merged) bucket under the pointer, else the
 * nearest segment edge (ties: lower stack index); heatmap: the bucket under the pointer. Null when
 * there is no mark: the caller clears the selection. Runs once per click, never per frame.
 */
import { bucketEnd } from '../../data/frames';
import type { HoverItem } from '../api';
import type { Span } from './camera';
import { bucketSpan, type LayerModel, type PickModel } from './draw';
import { bucketIndex, hoverRows, nearestIndex } from './pick';

interface Point {
  readonly x: number;
  readonly y: number;
}

export function pickItem(model: LayerModel, view: Span, p: Point): HoverItem | null {
  const pick = model.pick;
  const { plot } = model.summary;
  if (pick === null || !(plot.width > 0) || !(view.hi > view.lo)) return null;
  const t = view.lo + ((p.x - plot.x) / plot.width) * (view.hi - view.lo);
  switch (pick.kind) {
    case 'line':
      return pickLine(pick, t, p);
    case 'bars':
      return pickBars(pick, model, view, p);
    case 'heatmap': {
      const i = bucketIndex(pick.ref, t);
      if (i < 0) return null;
      const { tMs, rows } = hoverRows(pick, i, 'pointer', p.y);
      const row = rows[0];
      if (row === undefined) return null;
      return {
        kind: 'bucket',
        index: Number(row.key),
        tMs,
        toMs: bucketEnd(pick.ref, i, view.hi),
        count: row.value,
      };
    }
    case 'barchart':
      // A bar chart reports `pick`, never `select` (ADR-0028).
      return null;
  }
}

function pickLine(
  pick: Extract<PickModel, { kind: 'line' }>,
  t: number,
  p: Point,
): HoverItem | null {
  const i = nearestIndex(pick.ref, t);
  if (i < 0) return null;
  const { tMs, rows } = hoverRows(pick, i, 'pointer', p.y);
  let best: { key: string; value: number; d: number } | null = null;
  for (const r of rows) {
    const d = Math.abs(pick.y(r.value) - p.y);
    // Rows are in draw order: a tie keeps the earlier one.
    if (best === null || d < best.d) best = { key: r.key, value: r.value, d };
  }
  return best === null ? null : { kind: 'point', key: best.key, tMs, value: best.value };
}

function pickBars(
  pick: Extract<PickModel, { kind: 'bars' }>,
  model: LayerModel,
  view: Span,
  p: Point,
): HoverItem | null {
  const { plot } = model.summary;
  const { ts, series, lastEnd } = pick.drawn;
  const w = { fromMs: view.lo, toMs: view.hi };
  let col = -1;
  for (let k = 0; k < ts.length; k++) {
    const span = bucketSpan(plot, w, ts, k, lastEnd);
    // The column's bar and the 1 px gap after it.
    if (span !== null && p.x >= span[0] && p.x < span[0] + span[1] + 1) {
      col = k;
      break;
    }
  }
  if (col < 0) return null;
  let acc = 0;
  let best: { k: number; d: number } | null = null;
  for (let k = 0; k < series.length; k++) {
    const v = series[k]?.values[col] ?? 0;
    if (!(v > 0)) continue;
    const top = pick.y(acc + v);
    const bottom = pick.y(acc);
    acc += v;
    if (p.y >= top && p.y <= bottom) {
      best = { k, d: 0 };
      break;
    }
    const d = Math.min(Math.abs(p.y - top), Math.abs(p.y - bottom));
    // A tie keeps the lower stack index.
    if (best === null || d < best.d) best = { k, d };
  }
  const s = best === null ? undefined : series[best.k];
  if (best === null || s === undefined) return null;
  return { kind: 'point', key: s.key, tMs: ts[col] ?? NaN, value: s.values[col] ?? NaN };
}
