/**
 * The `<ChartFrame>` spec and data for every vis × result kind (plan #63 §4.3; SRF-030): when
 * `data` is not null, `validateFrameData(spec, data) === null`; when it is null no frame is
 * mounted and the card shows the notice. Isolating a series keeps only that series on line, bars
 * and stat; on a heatmap it keeps the full view's axis and fills only that series' row.
 */
import type { FrameData, ScalarFrame, SeriesFrame } from '../data/frames';
import type { Unit, VisKind, VisSpec } from '../engine/api';
import { MAX_STEPS } from '../data/step';
import { MAX_SERIES } from '../engine/canvas2d/Canvas2DEngine';
import type { ExploreResult } from './autovis';
import { histogramBuckets, isHistogram, isolateBucket } from './histogram';

export type FramePlan =
  | { readonly spec: VisSpec; readonly data: FrameData; readonly notice: null }
  | { readonly spec: VisSpec; readonly data: null; readonly notice: 'noBuckets' }
  | { readonly spec: VisSpec; readonly data: null; readonly notice: 'tooManyTimestamps' }
  | { readonly spec: null; readonly data: null; readonly notice: 'string' };

/**
 * The most values `commonGrid` allocates (series × distinct timestamps): every drawable series on
 * a grid of the most steps a range query has (review r2 #3).
 */
export const MAX_GRID_CELLS = MAX_SERIES * MAX_STEPS;

/** The key of a scalar drawn as a series (matches `KEY_PATTERN`). */
export const SCALAR_KEY = '0000000000000000';

/** A scalar as a one-point series, for the line and bars overrides. */
export function scalarSeries(s: ScalarFrame): SeriesFrame {
  return {
    key: SCALAR_KEY,
    labels: {},
    timestamps: Float64Array.of(s.timestampMs),
    values: Float64Array.of(s.value),
  };
}

/** Whether the series table offers row isolation (plan #63 D-ISO). */
function sameTimestamps(a: Float64Array, b: Float64Array): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * `series` on one grid (`bars`, §4.3): unchanged when they already share their timestamps, else
 * each on the sorted union of all timestamps with NaN where it has no sample. `null` when that grid
 * would pass `MAX_GRID_CELLS` (series × distinct timestamps); nothing is allocated for it then.
 */
export function commonGrid(series: readonly SeriesFrame[]): readonly SeriesFrame[] | null {
  const first = series[0];
  if (first === undefined || series.every((s) => sameTimestamps(s.timestamps, first.timestamps))) {
    return series;
  }
  const all = new Set<number>();
  for (const s of series) for (const t of s.timestamps) all.add(t);
  if (all.size * series.length > MAX_GRID_CELLS) return null;
  const grid = Float64Array.from(all).sort();
  const at = new Map<number, number>();
  grid.forEach((t, i) => at.set(t, i));
  return series.map((s) => {
    const values = new Float64Array(grid.length).fill(NaN);
    s.timestamps.forEach((t, i) => {
      const k = at.get(t);
      if (k !== undefined) values[k] = s.values[i] ?? NaN;
    });
    return { ...s, timestamps: grid, values };
  });
}

/** A bar chart isolates nothing: its table selects instead (#173 Part 3b §4.4). */
export function canIsolate(vis: VisKind | null, r: ExploreResult): boolean {
  if (vis === 'barchart') return false;
  return r.kind === 'series' && vis !== null && (vis !== 'heatmap' || isHistogram(r.series));
}

export function framePlan(
  // A geomap is planned by `vis/geo/` (T24-088; #234 Part 3), never here.
  vis: Exclude<VisKind, 'geomap'>,
  r: ExploreResult,
  o: { readonly isolatedKey: string | null; readonly title: string; readonly rateApplied: boolean },
): FramePlan {
  if (r.kind === 'string') return { spec: null, data: null, notice: 'string' };
  // A bar chart is planned by `vis/barchart.ts` (ADR-0028): Explore draws it from its model, and
  // this line plan only carries the unit of the Inspector's origin.
  if (vis === 'barchart') return framePlan('line', r, o);
  const unit: Unit = o.rateApplied ? { kind: 'suffix', suffix: '/s' } : { kind: 'none' };
  const { title } = o;
  const heat: VisSpec = { kind: 'heatmap', title, unit: { kind: 'none' }, countUnit: unit };
  const spec: VisSpec =
    vis === 'bars'
      ? { kind: 'bars', title, unit, stacking: 'normal', categoryLabel: '', categoryOrder: [] }
      : vis === 'heatmap'
        ? heat
        : { kind: vis, title, unit };
  if (r.kind === 'scalar') {
    switch (vis) {
      case 'stat':
        return { spec, data: { kind: 'scalar', scalar: r.scalar }, notice: null };
      case 'line':
      case 'bars':
        return { spec, data: { kind: 'series', series: [scalarSeries(r.scalar)] }, notice: null };
      case 'heatmap':
        return { spec, data: null, notice: 'noBuckets' };
    }
  }
  const isolated =
    o.isolatedKey === null ? undefined : r.series.find((s) => s.key === o.isolatedKey);
  if (vis !== 'heatmap') {
    const shown = isolated === undefined ? r.series : [isolated];
    const series = vis === 'bars' ? commonGrid(shown) : shown;
    if (series === null) return { spec, data: null, notice: 'tooManyTimestamps' };
    return { spec, data: { kind: 'series', series }, notice: null };
  }
  const heatmap =
    isolated === undefined ? histogramBuckets(r.series) : isolateBucket(r.series, isolated.key);
  if (heatmap === null) return { spec, data: null, notice: 'noBuckets' };
  return { spec, data: { kind: 'heatmap', heatmap }, notice: null };
}
