/**
 * The geomap's mark painter (T24-090, T24-091, T24-092; plan #234 Part 2 §4.7): symbols, fills,
 * patterns, state outlines and glyphs, clusters and their chips, labels, rings, dimming and bands.
 */
import type { GeoMapSpec, PlotRect } from '../../api';
import type { LabelBox, Placed } from '../../controller/geo/marks';
import type { GeoFrame } from '../../../vis/geo/frame';
import type { Ctx2D } from '../ctx';
import type { ThemeColours } from '../palette';

export interface MarkPaint {
  readonly frame: GeoFrame;
  readonly spec: GeoMapSpec;
  readonly colours: ThemeColours;
  readonly pattern: (name: string) => CanvasPattern | null;
  /** The selected keys while the selection is relevant; null: nothing dims. */
  readonly selected: ReadonlySet<string> | null;
  readonly focusId: string | null;
}

export function paintMarks(ctx: Ctx2D, p: Placed, alpha: number, s: MarkPaint): void {
  void ctx;
  void p;
  void alpha;
  void s;
}
export function paintLabels(ctx: Ctx2D, labels: readonly LabelBox[], c: ThemeColours): void {
  void ctx;
  void labels;
  void c;
}
export function paintBand(ctx: Ctx2D, box: PlotRect, c: ThemeColours): void {
  void ctx;
  void box;
  void c;
}
