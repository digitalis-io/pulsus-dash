/**
 * The one bar chart layout (ADR-0028, plan #173 Part 2 §3.4, §4.2): the plot, the visible category
 * names and the value-label rooms, used by the panel's fit and by the draw.
 */
import type { BarchartSpec, CategoryRow, PlotRect } from '../api';
import type { Measure } from './text';

/** The narrowest name room: `MMMM` in the axis font (T22-004). */
export function minNamePx(measure: Measure): number {
  return measure('MMMM');
}

/** The least plot dimension along the value axis: 2 × `minNamePx`. */
export function minPlotPx(measure: Measure): number {
  return 2 * minNamePx(measure);
}

export interface BarLayout {
  readonly plot: PlotRect;
  /** The visible names in row order; null = hidden. */
  readonly names: string[] | null;
  /** [before, after] the value axis: H left and right, V bottom and top. */
  readonly valueRooms: [number, number];
  /** The name band (H width, V height); a glyph column when names are hidden. */
  readonly band: number;
}

export function barLayout(
  spec: BarchartSpec,
  rows: readonly CategoryRow[],
  cssW: number,
  cssH: number,
  measure: Measure,
): BarLayout {
  void spec;
  void rows;
  void measure;
  return {
    plot: { x: 0, y: 0, width: cssW, height: cssH },
    names: null,
    valueRooms: [0, 0],
    band: 0,
  };
}
