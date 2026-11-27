/**
 * The geomap's rows (T24-089, T24-090, T24 §4.11, §5.15; plan #234 Part 1 §3.1, §4.1, §4.2): one
 * `GeoRow` per series with its value, value status, state, location, draw status and group; the
 * groups with their final labels, patterns and colours; the coverage counted before the cap; and
 * the validator of a row set. Pure and synchronous.
 */
import type { Completeness } from '../../data/decode';
import {
  EMPTY_COVERAGE,
  type Coverage,
  type FrameDataIssue,
  type Labels,
  type Reducer,
  type SeriesFrame,
  type State,
} from '../../data/frames';
import type { GeoView } from '../../engine/api';
import type { Thresholds } from '../thresholds';
import type { LocationOption, LocationResult } from './locate';
import type { Basemap, Gazetteer } from './types';

export type ValueStatus = 'ok' | 'noValue' | 'infinite' | 'outOfRange';
export type DrawStatus = 'shown' | 'notPlaced' | 'outsideMap' | 'excluded' | 'capped';
export type GroupId =
  | { readonly series: string }
  | { readonly present: true; readonly value: string }
  | { readonly present: false }
  | { readonly other: true };

export interface GeoRow {
  readonly key: string;
  readonly labels: Labels;
  readonly name: string;
  readonly value: number;
  readonly valueStatus: ValueStatus;
  readonly state: State | null;
  readonly location: LocationResult;
  readonly draw: DrawStatus;
  readonly group: number;
  readonly groupId: GroupId;
}

export interface GeoGroup {
  readonly id: GroupId;
  readonly label: string;
  readonly pattern: string;
  readonly colourIndex: number | null;
  readonly members: readonly GroupId[] | null;
  /** Parallel to `members`: the members' final labels. */
  readonly memberLabels: readonly string[] | null;
}

export interface GeoRowSet {
  /** By key (UTF-16 code units). */
  readonly rows: readonly GeoRow[];
  readonly groups: readonly GeoGroup[];
  readonly coverage: Coverage;
  /** The `groupBy` label key; null without one. */
  readonly groupBy: string | null;
}

export interface GeoFrame extends GeoRowSet {
  readonly seq: number;
  /** The indices of the `shown` rows. */
  readonly shown: Uint32Array;
  readonly basemap: Basemap;
}

export interface GeomapOptions {
  readonly location: LocationOption;
  readonly reducer: Reducer;
  readonly size: { readonly by: 'value' | 'fixed'; readonly min: number; readonly max: number };
  readonly colour: 'group' | 'state';
  readonly groupBy: string | null;
  readonly symbol: 'circle' | 'square' | 'triangle' | 'diamond';
  readonly labels: 'auto' | 'none';
  readonly cluster: boolean;
  readonly wheelZoom: boolean;
  readonly view: GeoView | null;
}

/** The most drawn rows (T22-006 above 5 000 drawable rows). */
export const GEO_CAP = 5000;
/** The Web Mercator latitude limit. */
export const MAX_LAT = 85.0511;

export function valueStatusOf(v: number): ValueStatus {
  void v;
  return 'ok';
}

export function geoRowSet(
  series: readonly SeriesFrame[],
  source: 'instant' | 'range',
  o: GeomapOptions,
  th: Thresholds | null,
  g: Gazetteer | null,
  q: Completeness,
): GeoRowSet {
  void [series, source, o, th, g, q];
  return { rows: [], groups: [], coverage: EMPTY_COVERAGE, groupBy: null };
}

export function validateGeoRows(s: GeoRowSet, th: Thresholds | null): FrameDataIssue | null {
  void [s, th];
  return null;
}

export function geoFrame(s: GeoRowSet, b: Basemap, seq: number): GeoFrame {
  return { ...s, seq, shown: new Uint32Array(0), basemap: b };
}

export function finalLabels(
  entries: readonly { key: string; labels: Labels; base: string }[],
  aggregate: number,
): string[] {
  void aggregate;
  return entries.map((e) => e.base);
}
