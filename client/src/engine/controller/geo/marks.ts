/**
 * The geomap's marks (T24-090, T24-091, T24 §4.11; plan #234 Part 2 §3.3, §4.6): radii, the
 * clusters of a level, the draw and keyboard orders and the labels. Pure and renderer-free.
 */
import type { GeoMapSpec } from '../../api';
import type { State } from '../../../theme/stateEncoding';
import type { GeoFrame } from '../../../vis/geo/frame';

/** One mark of a level: a marker (one row) or a cluster (≥ 2 rows, `cluster:` + the seed key). */
export interface LaidMark {
  readonly id: string;
  readonly kind: 'marker' | 'cluster';
  /** Sorted (UTF-16 code units). */
  readonly keys: readonly string[];
  /** Row indices, in key order. */
  readonly rows: readonly number[];
  /** The seed's row index. */
  readonly seed: number;
  /** World units [0, 1]. */
  readonly u: number;
  readonly v: number;
  readonly r: number;
  readonly rank: number;
  readonly absV: number;
}

/** Marks with their centres, CSS px (parallel arrays). */
export interface Placed {
  readonly marks: readonly LaidMark[];
  readonly x: Float64Array;
  readonly y: Float64Array;
}

export interface LabelBox {
  readonly id: string;
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function rankOf(s: State | null): number {
  void s;
  return 0;
}
export function radiiOf(f: GeoFrame, size: GeoMapSpec['size']): Float64Array {
  void size;
  return new Float64Array(f.rows.length);
}
export function levelMarks(
  f: GeoFrame,
  radii: Float64Array,
  z: number,
  cluster: boolean,
): LaidMark[] {
  void f;
  void radii;
  void z;
  void cluster;
  return [];
}
export function drawOrder(marks: readonly LaidMark[]): LaidMark[] {
  return [...marks];
}
export function keyboardOrder(p: Placed): LaidMark[] {
  return [...p.marks];
}
export function placeLabels(
  marks: readonly LaidMark[],
  name: (m: LaidMark) => string,
  at: (m: LaidMark) => { x: number; y: number },
  measure: (s: string) => number,
  w: number,
  h: number,
): LabelBox[] {
  void marks;
  void name;
  void at;
  void measure;
  void w;
  void h;
  return [];
}
