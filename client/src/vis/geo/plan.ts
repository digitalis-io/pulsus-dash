/**
 * The geomap's plan (T24-088, T24 §5.14; plan #234 Part 3 §3.1). Stub (tests first).
 */
import type { FrameDataIssue } from '../../data/frames';
import type { GeoMapSpec, GeoView, Unit } from '../../engine/api';
import type { ChartFrameProps, FrameSize } from '../../charts/ChartFrame';
import type { PanelRun } from '../../boards/usePanelRun';
import type { Thresholds } from '../thresholds';
import type { GeoFrame, GeoRowSet, GeomapOptions } from './frame';
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
  readonly seq: number;
  readonly motion: 'ease' | 'cut';
  readonly staleAtMs?: number | null;
}

export function geoSpec(
  p: Pick<GeoMapFrameProps, 'title' | 'unit' | 'options' | 'thresholds'>,
  view: GeoView | null,
  motion: 'ease' | 'cut',
): GeoMapSpec {
  return {
    kind: 'geomap',
    title: p.title,
    unit: p.unit,
    view,
    motion,
    size: p.options.size,
    colour: p.options.colour,
    symbol: p.options.symbol,
    labels: p.options.labels,
    cluster: p.options.cluster,
    wheelZoom: p.options.wheelZoom,
  };
}

export function planGeo(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  p: GeoMapFrameProps,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  size: FrameSize,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  view: GeoView | null,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  o: GeoPlanOptions,
): GeoPlan {
  return { state: 'invalid', issue: { code: 'kind' } };
}
