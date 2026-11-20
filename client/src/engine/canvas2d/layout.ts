/** The plot rectangle of a frame (plan #58 §3.4), from the tokens; CSS px. */
import { font, size, space } from '../../styles/tokens';
import type { PlotRect, VisKind } from '../api';

/** The height of one axis label line. */
export const LABEL_HEIGHT = Math.ceil(font.size.xs * font.lineHeight.tight);

/** The space under the plot: tick, padding above and below the time labels, one label line. */
const BOTTOM = size['chart-tick'] + 2 * space['1'] + LABEL_HEIGHT;

/** Stat fills the frame; the other kinds leave room for the value labels and the time axis. */
export function layoutPlot(
  kind: VisKind,
  cssW: number,
  cssH: number,
  valueLabelW: number,
): PlotRect {
  if (kind === 'stat') return { x: 0, y: 0, width: cssW, height: cssH };
  const x = valueLabelW + space['2'] + size['chart-tick'];
  const y = space['2'];
  return { x, y, width: cssW - x - space['2'], height: cssH - y - BOTTOM };
}
