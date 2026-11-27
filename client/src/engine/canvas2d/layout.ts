/** The plot rectangle of a frame (plan #58 §3.4), from the tokens; CSS px. */
import { font, size, space } from '../../styles/tokens';
import type { BarchartSpec, PlotRect, VisKind } from '../api';

/**
 * Canvas fonts (plan #58 Appendix A §A.3). Here rather than in `draw.ts`, which re-exports them, so
 * the e2e helpers read them without loading `StateEncoding`'s CSS module.
 */
export const AXIS_FONT = `${String(font.size.xs)}px ${font.family.mono}`;
export const STAT_FONT = `${String(font.weight.semibold)} ${String(font.size.display)}px ${font.family.ui}`;

/** The height of one axis label line. */
export const LABEL_HEIGHT = Math.ceil(font.size.xs * font.lineHeight.tight);

/** The event label band above the plot (ADR-0023): one label line and the gap under it. */
export const EVENT_BAND = LABEL_HEIGHT + space['1'];

/** The space under the plot: tick, padding above and below the time labels, one label line. */
export const BOTTOM = size['chart-tick'] + 2 * space['1'] + LABEL_HEIGHT;

/** A vertical bar chart's value-label band, left of the plot (ADR-0028). */
export const BAR_VALUE_BAND = 48;

/** A column of state glyphs: one label line wide and its gap (ADR-0028). */
export const GLYPH_COL = LABEL_HEIGHT + space['1'];

/**
 * The category extent of a bar chart in a `cssW` × `cssH` frame (ADR-0028, plan #173 Part 2 §3.3),
 * exactly as every engine lays it out: horizontal, the plot height; vertical, the plot width.
 */
export function categoryExtent(spec: BarchartSpec, cssW: number, cssH: number): number {
  // The drawn threshold lines (≤ 8, ADR-0022) take a glyph row (H) or column (V).
  const t = (spec.thresholds?.length ?? 0) > 0;
  const e =
    spec.orientation === 'horizontal'
      ? cssH - space['2'] - (t ? EVENT_BAND : 0) - BOTTOM
      : cssW -
        (BAR_VALUE_BAND + space['2'] + size['chart-tick']) -
        space['2'] -
        (t ? GLYPH_COL : 0);
  return Math.max(0, e);
}

/**
 * Stat fills the frame; the other kinds leave room for the value labels, the time axis and, when
 * the frame has events, the event label band above the plot (`eventBand`, ADR-0023).
 */
export function layoutPlot(
  kind: VisKind,
  cssW: number,
  cssH: number,
  valueLabelW: number,
  eventBand = 0,
): PlotRect {
  if (kind === 'stat' || kind === 'geomap') return { x: 0, y: 0, width: cssW, height: cssH };
  const x = valueLabelW + space['2'] + size['chart-tick'];
  const y = space['2'] + eventBand;
  return { x, y, width: cssW - x - space['2'], height: cssH - y - BOTTOM };
}
