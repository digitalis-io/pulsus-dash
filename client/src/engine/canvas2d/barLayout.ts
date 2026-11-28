/**
 * The one bar chart layout (ADR-0028, plan #173 Part 2 §3.4, §4.2): the plot, the visible category
 * names and the value-label rooms, used by the panel's fit (`vis/barchart.ts`, through an offscreen
 * measure) and by the draw (`barchart.ts`, through the layer's context), so both agree exactly.
 *
 * Horizontal: the name band on the left, at most 0.4 of the width; the plot from the band, a gap,
 * the tick and the left value room, `categoryExtent` high; the value axis below. Vertical: the
 * value band (`BAR_VALUE_BAND`) on the left, the plot `categoryExtent` wide, the top value room
 * above it, the bottom value room and the name band (at most 0.4 of the height) below it.
 */
import { size, space } from '../../styles/tokens';
import { formatValue } from '../../i18n/format';
import { t } from '../../i18n/t';
import { StateEncoding } from '../../theme/stateEncoding';
import type { BarchartSpec, CategoryRow, PlotRect } from '../api';
import { BAR_LABEL_HEIGHT, BAR_VALUE_BAND, categoryExtent, EVENT_BAND, GLYPH_COL } from './layout';
import { distinctLabels, type Measure } from './text';

/** The narrowest room a shortened name gets: `MMMM` in the bar font (T22-004). */
export function minNamePx(measure: Measure): number {
  return measure('MMMM');
}

/** The least plot dimension along the value axis the fit mounts: 2 × `minNamePx`. */
export function minPlotPx(measure: Measure): number {
  return 2 * minNamePx(measure);
}

export interface BarLayout {
  readonly plot: PlotRect;
  /** The visible names in row order (`distinctLabels`); null = hidden. */
  readonly names: string[] | null;
  /** The value-label rooms outside the plot: H [left, right], V [bottom, top]; 0 when off. */
  readonly valueRooms: [number, number];
  /** The name band (H width, V height): a glyph column when the names are hidden. */
  readonly band: number;
  /** The width of `glyph ` before a name; 0 without states. */
  readonly glyphW: number;
}

/** The text of a bar's value label: `formatValue`, or `no data` for a non-finite value. */
export function valueText(r: CategoryRow, spec: BarchartSpec): string {
  return Number.isFinite(r.value) ? formatValue(r.value, spec.unit) : t('chart.bar.noData');
}

/** The value-label rooms: H the widest negative and the widest other label plus a gap. */
function valueRooms(
  spec: BarchartSpec,
  rows: readonly CategoryRow[],
  measure: Measure,
): [number, number] {
  if (!spec.valueLabels) return [0, 0];
  let neg = 0;
  let pos = 0;
  let anyNeg = false;
  let anyPos = false;
  for (const r of rows) {
    const w = measure(valueText(r, spec));
    if (r.value < 0) {
      anyNeg = true;
      neg = Math.max(neg, w);
    } else {
      anyPos = true;
      pos = Math.max(pos, w);
    }
  }
  if (spec.orientation === 'vertical') {
    return [anyNeg ? BAR_LABEL_HEIGHT : 0, anyPos ? BAR_LABEL_HEIGHT : 0];
  }
  return [anyNeg ? Math.ceil(neg) + space['1'] : 0, anyPos ? Math.ceil(pos) + space['1'] : 0];
}

export function barLayout(
  spec: BarchartSpec,
  rows: readonly CategoryRow[],
  cssW: number,
  cssH: number,
  measure: Measure,
): BarLayout {
  const horizontal = spec.orientation === 'horizontal';
  const extent = categoryExtent(spec, cssW, cssH);
  const rooms = valueRooms(spec, rows, measure);
  const states = rows.some((r) => r.state !== null);
  let glyphW = 0;
  if (states) {
    for (const r of rows)
      if (r.state !== null) glyphW = Math.max(glyphW, measure(`${StateEncoding[r.state].glyph} `));
  }
  let names: string[] | null = null;
  let band = 0;
  if (spec.names !== 'hidden' && rows.length > 0) {
    let widest = 0;
    for (const r of rows) widest = Math.max(widest, measure(r.name));
    const cap = Math.floor(0.4 * (horizontal ? cssW : cssH));
    band = Math.min(Math.ceil(widest + glyphW) + space['2'], cap);
    names = distinctLabels(
      measure,
      rows.map((r) => r.name),
      band - space['2'] - glyphW,
    );
  }
  if (names === null) band = states ? GLYPH_COL : 0;
  const thresholds = (spec.thresholds?.length ?? 0) > 0;
  let plot: PlotRect;
  if (horizontal) {
    const x = band + space['2'] + size['chart-tick'] + rooms[0];
    const y = space['2'] + (thresholds ? EVENT_BAND : 0);
    plot = { x, y, width: cssW - x - space['2'] - rooms[1], height: extent };
  } else {
    const x = BAR_VALUE_BAND + space['2'] + size['chart-tick'];
    const y = space['2'] + rooms[1];
    plot = { x, y, width: extent, height: cssH - y - rooms[0] - band };
  }
  return { plot, names, valueRooms: rooms, band, glyphW };
}
