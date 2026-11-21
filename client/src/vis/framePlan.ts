/**
 * The `<ChartFrame>` spec and data for every vis × result kind (plan #63 §4.3; SRF-030): when
 * `data` is not null, `validateFrameData(spec, data) === null`; when it is null no frame is
 * mounted and the card shows the notice. Isolating a series keeps only that series on line, bars
 * and stat; on a heatmap it keeps the full view's axis and fills only that series' row.
 */
import type { FrameData, ScalarFrame, SeriesFrame } from '../data/frames';
import type { Unit, VisKind, VisSpec } from '../engine/api';
import type { ExploreResult } from './autovis';
import { histogramBuckets, isolateBucket } from './histogram';

export type FramePlan =
  | { readonly spec: VisSpec; readonly data: FrameData; readonly notice: null }
  | { readonly spec: VisSpec; readonly data: null; readonly notice: 'noBuckets' }
  | { readonly spec: null; readonly data: null; readonly notice: 'string' };

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
export function canIsolate(vis: VisKind | null, r: ExploreResult): boolean {
  return (
    r.kind === 'series' &&
    vis !== null &&
    (vis !== 'heatmap' || histogramBuckets(r.series) !== null)
  );
}

export function framePlan(
  vis: VisKind,
  r: ExploreResult,
  o: { readonly isolatedKey: string | null; readonly title: string; readonly rateApplied: boolean },
): FramePlan {
  if (r.kind === 'string') return { spec: null, data: null, notice: 'string' };
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
    const series = isolated === undefined ? r.series : [isolated];
    return { spec, data: { kind: 'series', series }, notice: null };
  }
  const heatmap =
    isolated === undefined ? histogramBuckets(r.series) : isolateBucket(r.series, isolated.key);
  if (heatmap === null) return { spec, data: null, notice: 'noBuckets' };
  return { spec, data: { kind: 'heatmap', heatmap }, notice: null };
}
