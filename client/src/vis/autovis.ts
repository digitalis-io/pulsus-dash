/**
 * Auto-vis (plan #63 §4.2; VIZ-065 Table 5-13 rows 5, 6, 7, 14; SRF-030): the vis the Explore page
 * draws a result with, unless the URL's `vis` overrides it. The first matching row wins.
 */
import type { Completeness, InstantResult, RangeFrame } from '../data/decode';
import type { ScalarFrame, SeriesFrame } from '../data/frames';
import type { VisKind } from '../engine/api';
import { isHistogram } from './histogram';

/** A query result as the Explore page shows it. */
export type ExploreResult =
  | {
      readonly kind: 'series';
      /** A range result is gridded by the BFF; an instant result is not. */
      readonly source: 'range' | 'instant';
      readonly series: readonly SeriesFrame[];
      readonly stepMs: number | null;
      readonly completeness: Completeness;
    }
  | { readonly kind: 'scalar'; readonly scalar: ScalarFrame; readonly completeness: Completeness }
  | { readonly kind: 'string'; readonly value: string; readonly completeness: Completeness };

/** Frames on a range grid: a PromQL range result, a log volume or a LogQL metric answer. */
export function fromRange(r: RangeFrame): ExploreResult {
  return {
    kind: 'series',
    source: 'range',
    series: r.series,
    stepMs: r.stepMs,
    completeness: r.completeness,
  };
}

export function fromInstant(r: InstantResult): ExploreResult {
  switch (r.kind) {
    case 'series':
      return {
        kind: 'series',
        source: 'instant',
        series: r.series,
        stepMs: null,
        completeness: r.completeness,
      };
    case 'scalar':
      return { kind: 'scalar', scalar: r.scalar, completeness: r.completeness };
    case 'string':
      return { kind: 'string', value: r.value, completeness: r.completeness };
  }
}

export interface AutoVis {
  readonly vis: VisKind | null;
  /** The Table 5-13 row that chose `vis`. */
  readonly rule: 5 | 6 | 7 | 11 | 14 | null;
}

/** The kinds every surface draws today; #173 Part 3 adds `barchart` for boards. */
export const SHIPPED_VIS: ReadonlySet<VisKind> = new Set<VisKind>([
  'line',
  'bars',
  'heatmap',
  'stat',
]);

/**
 * The auto vis of a result. A range result is never a stat (row 7 is "1 series, 1 value"): the
 * BFF grids it, so a series with one sample is a series with gaps.
 */
export function autoVis(i: {
  readonly histogram: boolean;
  readonly rateApplied: boolean;
  readonly result: ExploreResult;
  /** The panel has an explicit `options.reducer`. */
  readonly reducer?: boolean;
  /** Default `SHIPPED_VIS`. */
  readonly available?: ReadonlySet<VisKind>;
}): AutoVis {
  const r = i.result;
  if (r.kind === 'string') return { vis: null, rule: null };
  if (i.histogram && r.kind === 'series' && isHistogram(r.series)) {
    return { vis: 'heatmap', rule: 5 };
  }
  if (i.rateApplied) return { vis: 'line', rule: 6 };
  if (
    r.kind === 'scalar' ||
    (r.source === 'instant' && r.series.length === 1 && r.series[0]?.timestamps.length === 1)
  ) {
    return { vis: 'stat', rule: 7 };
  }
  return { vis: 'line', rule: 14 };
}

/** The URL's `vis` key: a vis kind, or `auto`. */
export type VisParam = VisKind | 'auto';

/** The vis drawn: the URL's override, else the auto vis. */
export function chooseVis(param: VisParam, auto: AutoVis): VisKind | null {
  return param === 'auto' ? auto.vis : param;
}
