/**
 * Shared setup of the geomap host tests (plan #234 Part 3 §5): a `PanelRun` over a fixture result,
 * the geo assets (an empty basemap and gazetteer T) and `GeoMapFrame` props on fixture G.
 */
import type { PanelRun } from '../boards/usePanelRun';
import { EMPTY_BASEMAP, type SeriesFrame } from '../data/frames';
import type { Completeness } from '../data/decode';
import type { Unit } from '../engine/api';
import type { GeoMapFrameProps } from '../vis/geo/plan';
import { COMPLETE, G, gazT, opts, TH } from '../vis/geo/fixtures/series';
import type { GeomapOptions } from '../vis/geo/frame';
import type { GeoData } from '../vis/geo/types';
import type { Thresholds } from '../vis/thresholds';

export const MS: Unit = { kind: 'time', base: 'ms' };

/** The assets of a host test: an empty basemap (the plot is water) and gazetteer T. */
export const GEO_DATA: GeoData = Object.freeze({ basemap: EMPTY_BASEMAP, gazetteer: gazT() });

/** A run that answered `series` as an instant result (`null`: no outcome yet). */
export function runOf(
  series: readonly SeriesFrame[] | null,
  o: Partial<PanelRun> & { completeness?: Completeness } = {},
): PanelRun {
  const { completeness, ...rest } = o;
  return {
    text: 'up',
    blocked: null,
    missing: [],
    tooMany: null,
    refusal: null,
    ready: true,
    outcome:
      series === null
        ? null
        : {
            key: ['k'],
            planned: {
              query: 'up',
              expanded: 'up',
              bytes: 2,
              valueType: 'vector',
              rateCandidate: false,
              rateApplied: false,
              histogram: false,
            },
            result: {
              kind: 'series',
              source: 'instant',
              series,
              stepMs: null,
              completeness: completeness ?? COMPLETE,
            },
          },
    error: null,
    diagnostics: [],
    fetching: false,
    stepMs: 5000,
    expanded: 'up',
    stream: null,
    placeholder: false,
    retry: () => undefined,
    ...rest,
  };
}

/** Host props on `series` (default G) with thresholds TH unless `thresholds` is given. */
export function hostProps(
  series: readonly SeriesFrame[] | null = G(),
  o: {
    run?: Partial<PanelRun>;
    options?: Partial<GeomapOptions>;
    thresholds?: Thresholds | null;
    geoData?: GeoData | 'loading';
    title?: string;
  } = {},
): GeoMapFrameProps {
  return {
    panelId: 'p1',
    title: o.title ?? 'Latency map',
    unit: MS,
    options: opts(o.options),
    thresholds: o.thresholds === undefined ? TH : o.thresholds,
    run: runOf(series, o.run),
    geoData: o.geoData ?? GEO_DATA,
  };
}

/**
 * The table's grid (`[role=grid]`) is 1200 × 900 in jsdom, so every row of a fixture is mounted by
 * the virtualiser; other elements keep their jsdom sizes. Returns the restore.
 */
export function installGridLayout(): () => void {
  const names = ['clientWidth', 'clientHeight', 'offsetWidth', 'offsetHeight'] as const;
  const saved = names.map(
    (n) => [n, Object.getOwnPropertyDescriptor(HTMLElement.prototype, n)] as const,
  );
  for (const n of names) {
    const base = Object.getOwnPropertyDescriptor(HTMLElement.prototype, n);
    Object.defineProperty(HTMLElement.prototype, n, {
      configurable: true,
      get(this: HTMLElement): number {
        if (this.getAttribute('role') === 'grid') return n.endsWith('Width') ? 1200 : 900;
        const v: unknown = base?.get?.call(this);
        return typeof v === 'number' ? v : 0;
      },
    });
  }
  return () => {
    for (const [n, d] of saved) {
      if (d === undefined) Reflect.deleteProperty(HTMLElement.prototype, n);
      else Object.defineProperty(HTMLElement.prototype, n, d);
    }
  };
}
