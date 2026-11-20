/**
 * The heatmap bucket axis (plan #58 §4.1, VL-006, VIZ-013). Each bucket spans its numeric interval:
 * log over at least three decades of positive bounds, else linear; a final +Inf bucket gets its own
 * band at the top. Bucket 0 spans `(lo, bounds[0]]`, so every finite row has a height.
 */
import type { PlotRect } from '../api';
import { valueTicks } from './valueTicks';

export interface BucketRow {
  readonly lower: number;
  readonly upper: number;
  /** The lower edge's y (larger) and the upper edge's y, CSS px. */
  readonly y0: number;
  readonly y1: number;
}

export interface BucketScale {
  readonly kind: 'log' | 'linear';
  readonly rows: readonly BucketRow[];
  readonly infBand: { y0: number; y1: number } | null;
  readonly ticks: readonly number[];
  /** The y (CSS px) of a value on the finite scale. */
  readonly y: (v: number) => number;
}

const INF_GAP = 2;

function powersOfTen(lo: number, hi: number, mults: readonly number[]): number[] {
  const out: number[] = [];
  for (let k = Math.floor(Math.log10(lo)) - 1; k <= Math.ceil(Math.log10(hi)) + 1; k++) {
    for (const m of mults) {
      const v = Number(`${String(m)}e${String(k)}`);
      if (v >= lo && v <= hi) out.push(v);
    }
  }
  return out.sort((a, b) => a - b);
}

export function bucketScale(
  bounds: Float64Array,
  plot: PlotRect,
  labelHeightPx: number,
): BucketScale {
  const b = bounds.length;
  const hasInf = b > 0 && bounds[b - 1] === Infinity;
  const finite = Array.from(hasInf ? bounds.subarray(0, b - 1) : bounds);
  const first = finite[0] ?? 0;
  const hi = finite.at(-1) ?? 0;
  const infHeight = hasInf ? Math.max(labelHeightPx, Math.round(plot.height / Math.max(1, b))) : 0;
  const top = plot.y + infHeight + (hasInf ? INF_GAP : 0);
  const height = plot.y + plot.height - top;
  const log = finite.length >= 2 && first > 0 && hi / first >= 1000;
  let lo: number;
  let widened = false;
  if (log) {
    lo = (first * first) / (finite[1] ?? first);
  } else {
    lo = Math.min(0, first);
    if (lo === hi) {
      lo = hi - 1;
      widened = true;
    } else if (finite.length >= 2 && lo >= first) {
      // A first bound ≤ 0: one bucket width below it (r4-1).
      lo = first - ((finite[1] ?? first) - first);
    }
  }
  const g = log ? Math.log10 : (v: number) => v;
  const glo = g(lo);
  const span = g(hi) - glo;
  const y = (v: number): number => top + (1 - (g(v) - glo) / span) * height;
  const rows: BucketRow[] = finite.map((upper, i) => {
    const lower = i === 0 ? lo : (finite[i - 1] ?? lo);
    return { lower, upper, y0: y(lower), y1: y(upper) };
  });
  let ticks: number[];
  if (log) {
    const powers = powersOfTen(lo, hi, [1]);
    const dense = powersOfTen(lo, hi, [1, 2, 5]);
    let minGap = Infinity;
    for (let i = 1; i < dense.length; i++) {
      minGap = Math.min(minGap, y(dense[i - 1] ?? 0) - y(dense[i] ?? 0));
    }
    ticks = minGap >= labelHeightPx + 2 ? dense : powers;
  } else if (widened) {
    ticks = [hi];
  } else {
    ticks = valueTicks(lo, hi, height, labelHeightPx, 1000).ticks.filter((t) => t >= lo && t <= hi);
  }
  return {
    kind: log ? 'log' : 'linear',
    rows,
    infBand: hasInf ? { y0: plot.y, y1: plot.y + infHeight } : null,
    ticks,
    y,
  };
}
