/** Picking on raw samples (plan #58 §4.3): hover reads the data, not the drawn columns. */
import { seriesName } from '../../data/frames';
import { formatValue } from '../../i18n/format';
import { t } from '../../i18n/t';
import type { HoverEvent, HoverRow } from '../api';
import type { Span } from './camera';
import type { LayerModel, PickModel } from './draw';
import { seriesColourIndex } from './palette';

/** The index of the timestamp nearest `tMs` (binary search; ties → lower index); −1 if empty. */
export function nearestIndex(ts: Float64Array, tMs: number): number {
  const n = ts.length;
  if (n === 0) return -1;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((ts[mid] ?? 0) < tMs) lo = mid + 1;
    else hi = mid;
  }
  // lo is the first index with ts ≥ tMs (or n − 1).
  if (lo > 0 && tMs - (ts[lo - 1] ?? 0) <= (ts[lo] ?? 0) - tMs) return lo - 1;
  return lo;
}

/** The index of the bucket whose start is the last at or before `tMs` (0 before the first). */
export function bucketIndex(ts: Float64Array, tMs: number): number {
  const n = ts.length;
  if (n === 0) return -1;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((ts[mid] ?? 0) <= tMs) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Half the mean sample step of a series; ∞ for one sample. */
function halfStep(ts: Float64Array): number {
  const n = ts.length;
  return n > 1 ? ((ts[n - 1] ?? 0) - (ts[0] ?? 0)) / (n - 1) / 2 : Infinity;
}

/**
 * The hover rows at reference index `i` (plan #58 §4.3). Line: every shown series whose nearest
 * sample is within half its own step; bars: one row per category; heatmap: the bucket under `yCss`
 * (pointer) or every bucket top first (keyboard). NaN values are omitted.
 */
export function hoverRows(
  pick: PickModel,
  i: number,
  source: 'pointer' | 'keyboard',
  yCss: number,
): { tMs: number; rows: HoverRow[] } {
  const tMs = pick.ref[i] ?? NaN;
  const rows: HoverRow[] = [];
  switch (pick.kind) {
    case 'line':
      for (const s of pick.series) {
        const j = nearestIndex(s.timestamps, tMs);
        if (j < 0 || Math.abs((s.timestamps[j] ?? NaN) - tMs) > halfStep(s.timestamps)) continue;
        const value = s.values[j] ?? NaN;
        if (!Number.isFinite(value)) continue;
        rows.push({
          key: s.key,
          name: seriesName(s.labels),
          colourIndex: seriesColourIndex(s),
          value,
        });
      }
      break;
    case 'bars':
      for (const s of pick.series) {
        const value = s.values[i] ?? NaN;
        if (!Number.isFinite(value)) continue;
        const name = s.labels[pick.categoryLabel] ?? seriesName(s.labels);
        rows.push({ key: s.key, name, colourIndex: seriesColourIndex(s), value });
      }
      break;
    case 'heatmap': {
      const { bounds, counts } = pick.heatmap;
      const nb = bounds.length;
      const row = (b: number): void => {
        const value = counts[i * nb + b] ?? NaN;
        if (!Number.isFinite(value)) return;
        const upper = bounds[b] ?? NaN;
        const name =
          upper === Infinity
            ? t('chart.bucket.gt', { bound: formatValue(bounds[b - 1] ?? NaN, pick.unit) })
            : t('chart.bucket.le', { bound: formatValue(upper, pick.unit) });
        rows.push({ key: String(b), name, colourIndex: null, value });
      };
      if (source === 'keyboard') {
        for (let b = nb - 1; b >= 0; b--) row(b);
        break;
      }
      const band = pick.scale.infBand;
      if (band !== null && yCss >= band.y0 && yCss <= band.y1) {
        row(nb - 1);
        break;
      }
      const b = pick.scale.rows.findIndex((r) => yCss >= r.y1 && yCss <= r.y0);
      if (b >= 0) row(b);
      break;
    }
    case 'barchart':
      // No time axis: a bar chart reports `mark`, never `hover` (ADR-0028).
      break;
  }
  return { tMs, rows };
}

/** Stub (plan #68 C2b): the hover of a layer model at a key index or pointer. */
/**
 * The hover of a drawn layer (plan #68 C2b: moved from `Canvas2DFrame`, unchanged; the source of
 * `engine/fixtures/hover.json`, which the engine's `dash-scene::hover` port must reproduce): the
 * keyboard crosshair at reference index `keyIndex` (y = the plot's top), else the pointer's
 * nearest sample (line) or bucket (bars, heatmap); null without a pick model or a hover.
 */
export function hoverAt(
  m: LayerModel,
  v: Span,
  keyIndex: number | null,
  p: { readonly x: number; readonly y: number } | null,
): HoverEvent | null {
  if (m.pick === null) return null;
  const { plot } = m.summary;
  const xOf = (t: number): number => plot.x + ((t - v.lo) / (v.hi - v.lo)) * plot.width;
  if (keyIndex !== null) {
    const { tMs, rows } = hoverRows(m.pick, keyIndex, 'keyboard', plot.y);
    return { source: 'keyboard', tMs, xCss: xOf(tMs), yCss: plot.y, rows };
  }
  if (p === null) return null;
  const t = v.lo + ((p.x - plot.x) / plot.width) * (v.hi - v.lo);
  const i = m.pick.kind === 'line' ? nearestIndex(m.pick.ref, t) : bucketIndex(m.pick.ref, t);
  if (i < 0) return null;
  const { tMs, rows } = hoverRows(m.pick, i, 'pointer', p.y);
  return { source: 'pointer', tMs, xCss: xOf(tMs), yCss: p.y, rows };
}
