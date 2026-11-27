/**
 * The geomap's Inspector targets (T24-092, T24 §4.13, §5.16; plan #234 Part 1 §4.4): snapshots of
 * a row set.
 */
import type { Labels } from '../../data/frames';
import type { GeoRow, GeoRowSet } from './frame';

export interface GeoMemberEntry {
  readonly text: string;
  readonly labels: Labels;
  readonly keys: readonly string[];
}

export interface GeoInspectorTarget {
  readonly kind: 'marker' | 'cluster' | 'aggregate' | 'group';
  readonly id: string;
  readonly frameSeq: number;
  readonly title: string;
  /** A snapshot, in key order. */
  readonly rows: readonly GeoRow[];
  /** Null for a marker. */
  readonly members: readonly GeoMemberEntry[] | null;
  /** The row set the target was built from. */
  readonly set: GeoRowSet;
}

export type GeoTargetRef =
  | { readonly kind: 'marker' | 'cluster'; readonly id: string; readonly keys: readonly string[] }
  | { readonly kind: 'aggregate' }
  | { readonly kind: 'group'; readonly from: GeoInspectorTarget; readonly entry: number };

export function geoTarget(s: GeoRowSet, frameSeq: number, ref: GeoTargetRef): GeoInspectorTarget {
  void ref;
  return { kind: 'marker', id: '', frameSeq, title: '', rows: [], members: null, set: s };
}

export function geoPlace(r: GeoRow): string {
  void r;
  return '';
}
