/**
 * The geomap gallery's pages (development and stub builds only; plan #234 Part 3 §2, §5): fixture
 * results as panel runs, for `golden:gallery`, `e2e:geomap-offline` and `bench:geomap-markers`.
 * Gazetteer T (T24 §10.3) places the fixtures; the basemap is the bundled one.
 */
import type { PanelRun } from '../boards/usePanelRun';
import type { SeriesFrame } from '../data/frames';
import type { GeoView, Unit } from '../engine/api';
import { Cap, COMPLETE, G, H, opts, TH } from '../vis/geo/fixtures/series';
import type { GeomapOptions } from '../vis/geo/frame';
import type { Thresholds } from '../vis/thresholds';

export const GEO_GALLERY_PAGES = [
  'geomap-markers',
  'geomap-groups',
  'geomap-states',
  'geomap-offline',
  'geomap-bench',
] as const;
export type GeoGalleryPage = (typeof GEO_GALLERY_PAGES)[number];

/** `?page=`; an unknown value is the markers page. */
export function geoGalleryPage(v: string | null): GeoGalleryPage {
  return (GEO_GALLERY_PAGES as readonly string[]).includes(v ?? '')
    ? (v as GeoGalleryPage)
    : 'geomap-markers';
}

/** Every gallery map is 1024 × 512 CSS px (the fixtures' plot, T24 §10.4). */
export const GEO_GALLERY_W = 1024;
export const GEO_GALLERY_H = 512;

export interface GeoGalleryEntry {
  readonly id: string;
  readonly title: string;
  readonly series: readonly SeriesFrame[];
  readonly options: GeomapOptions;
  readonly thresholds: Thresholds | null;
}

const MS: Unit = { kind: 'time', base: 'ms' };
export const GEO_GALLERY_UNIT = MS;

/** The offline page's view: Dublin at zoom 6. */
const DUBLIN: GeoView = { lat: 53.34, lon: -6.25, zoom: 6 };

export function geoGalleryEntries(page: GeoGalleryPage): GeoGalleryEntry[] {
  switch (page) {
    case 'geomap-markers':
      return [
        { id: page, title: 'Latency by region', series: G(), options: opts(), thresholds: null },
      ];
    case 'geomap-groups':
      return [
        {
          id: page,
          title: 'Latency by environment',
          series: H(),
          options: opts({ groupBy: 'env' }),
          thresholds: null,
        },
      ];
    case 'geomap-states':
      return [
        {
          id: 'geomap-states-group',
          title: 'Latency against thresholds (group colours)',
          series: G(),
          options: opts(),
          thresholds: TH,
        },
        {
          id: 'geomap-states-state',
          title: 'Latency against thresholds (state colours)',
          series: G(),
          options: opts({ colour: 'state' }),
          thresholds: TH,
        },
      ];
    case 'geomap-offline':
      return [
        {
          id: page,
          title: 'Basemap offline',
          series: [],
          options: opts({ view: DUBLIN }),
          thresholds: null,
        },
      ];
    case 'geomap-bench':
      return [
        {
          id: page,
          title: 'Five thousand markers',
          series: Cap(),
          options: opts(),
          thresholds: null,
        },
      ];
  }
}

/** A run that answered `series` as an instant result. */
export function galleryRun(series: readonly SeriesFrame[]): PanelRun {
  return {
    text: 'gallery',
    blocked: null,
    missing: [],
    tooMany: null,
    refusal: null,
    ready: true,
    outcome: {
      key: ['gallery'],
      planned: {
        query: 'gallery',
        expanded: 'gallery',
        bytes: 7,
        valueType: 'vector',
        rateCandidate: false,
        rateApplied: false,
        histogram: false,
      },
      result: { kind: 'series', source: 'instant', series, stepMs: null, completeness: COMPLETE },
    },
    error: null,
    diagnostics: [],
    fetching: false,
    stepMs: null,
    expanded: 'gallery',
    stream: null,
    placeholder: false,
    retry: () => undefined,
  };
}
