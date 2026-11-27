/**
 * The geomap's plan (T24-088, T24 §5.14; plan #234 Part 3 §3.1): what a geomap panel shows for its
 * run, assets, plot size and view, the first that holds: a pending run → `loading`; a failed run
 * with nothing to keep → `error`; a string result or a row set `validateGeoRows` refuses →
 * `invalid`; no basemap → `mapDataUnavailable`; a plot under 160 × 120 CSS px → `tooSmall`; no
 * rows → `empty`; no shown row → `noneShown`; else `ok`. Only the last three build a frame. A
 * refetch that failed on the same key keeps its rows, marked stale from `staleAtMs`. Pure.
 */
import type { FrameDataIssue, SeriesFrame } from '../../data/frames';
import type { GeoMapSpec, GeoView, Unit } from '../../engine/api';
import type { ChartFrameProps, FrameSize } from '../../charts/ChartFrame';
import type { PanelRun } from '../../boards/usePanelRun';
import { scalarSeries } from '../framePlan';
import { thresholdLines, type Thresholds } from '../thresholds';
import {
  geoFrame,
  geoRowSet,
  validateGeoRows,
  type GeoFrame,
  type GeoRowSet,
  type GeomapOptions,
} from './frame';
import type { GeoData } from './types';

export interface GeoMapFrameProps {
  readonly panelId: string;
  readonly title: string;
  readonly unit: Unit;
  readonly options: GeomapOptions;
  readonly thresholds: Thresholds | null;
  readonly run: PanelRun;
  readonly geoData: GeoData | 'loading';
  readonly fill?: boolean;
  readonly sizeMemo?: { current: FrameSize | null };
  readonly onInspect?: ChartFrameProps['onInspect'];
}

export type GeoPlan =
  | { readonly state: 'loading' | 'error'; readonly rows: GeoRowSet | null }
  | { readonly state: 'invalid'; readonly issue: FrameDataIssue }
  | { readonly state: 'mapDataUnavailable' | 'tooSmall'; readonly rows: GeoRowSet }
  | {
      readonly state: 'empty' | 'noneShown' | 'ok';
      readonly rows: GeoRowSet;
      readonly spec: GeoMapSpec;
      readonly data: { readonly kind: 'geo'; readonly geo: GeoFrame };
    };

export interface GeoPlanOptions {
  /** The frame sequence: +1 per new row set (the host's). */
  readonly seq: number;
  /** `cut` under reduced motion. */
  readonly motion: 'ease' | 'cut';
  /** When a same-key refetch failure was first seen (the meter's `stale (HH:mm:ss)`); else none. */
  readonly staleAtMs?: number | null;
}

/** The smallest plot a map is drawn in, CSS px (T24-088). */
export const MIN_MAP_W = 160;
export const MIN_MAP_H = 120;

/** The `GeoMapSpec` of the panel at `view` (T24 §5.14); thresholds as seam lines when set. */
export function geoSpec(
  p: Pick<GeoMapFrameProps, 'title' | 'unit' | 'options' | 'thresholds'>,
  view: GeoView | null,
  motion: 'ease' | 'cut',
): GeoMapSpec {
  const o = p.options;
  return {
    kind: 'geomap',
    title: p.title,
    unit: p.unit,
    view,
    motion,
    size: o.size,
    colour: o.colour,
    symbol: o.symbol,
    labels: o.labels,
    cluster: o.cluster,
    wheelZoom: o.wheelZoom,
    ...(p.thresholds === null ? {} : { thresholds: thresholdLines(p.thresholds, p.unit) }),
  };
}

/** The row set of the run's result; a `string` result is `{code: 'kind'}`. */
function rowsOf(p: GeoMapFrameProps, assets: GeoData): GeoRowSet | FrameDataIssue {
  const r = p.run.outcome?.result;
  if (r === undefined || r.kind === 'string') return { code: 'kind' };
  const series: readonly SeriesFrame[] = r.kind === 'scalar' ? [scalarSeries(r.scalar)] : r.series;
  const source = r.kind === 'series' ? r.source : 'instant';
  return geoRowSet(series, source, p.options, p.thresholds, assets.gazetteer, r.completeness);
}

const isIssue = (x: GeoRowSet | FrameDataIssue): x is FrameDataIssue => 'code' in x;

export function planGeo(
  p: GeoMapFrameProps,
  size: FrameSize,
  view: GeoView | null,
  o: GeoPlanOptions,
): GeoPlan {
  const run = p.run;
  if (
    p.geoData === 'loading' ||
    (run.outcome === null && run.error === null) ||
    (run.placeholder && run.fetching)
  ) {
    return { state: 'loading', rows: null };
  }
  if (run.error !== null && (run.outcome === null || run.placeholder)) {
    return { state: 'error', rows: null };
  }
  const got = rowsOf(p, p.geoData);
  if (isIssue(got)) return { state: 'invalid', issue: got };
  const issue = validateGeoRows(got, p.thresholds);
  if (issue !== null) return { state: 'invalid', issue };
  const rows: GeoRowSet =
    run.error !== null && o.staleAtMs !== undefined && o.staleAtMs !== null
      ? { ...got, coverage: { ...got.coverage, staleAtMs: o.staleAtMs } }
      : got;
  const basemap = p.geoData.basemap;
  if (basemap === null) return { state: 'mapDataUnavailable', rows };
  if (size.width < MIN_MAP_W || size.height < MIN_MAP_H) return { state: 'tooSmall', rows };
  const geo = geoFrame(rows, basemap, o.seq);
  const spec = geoSpec(p, view, o.motion);
  const data = { kind: 'geo' as const, geo };
  if (rows.rows.length === 0) return { state: 'empty', rows, spec, data };
  if (geo.shown.length === 0) return { state: 'noneShown', rows, spec, data };
  return { state: 'ok', rows, spec, data };
}
