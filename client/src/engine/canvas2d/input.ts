/**
 * Input classification for the interim 2D camera (#93, plan §3.3, §4.1): the zone under the
 * pointer and what a press does. The wheel intent, the pinch heuristic and the page-wheel latch are
 * renderer-neutral (`controller/input.ts`, shared with the geomap) and re-exported here.
 */
import type { PlotRect, VisKind } from '../api';

export {
  DRAG_MIN_PX,
  hasZoomModifier,
  isPinch,
  PAGE_WHEEL_LATCH_MS,
  PINCH_ZOOM_PER_PX,
  WHEEL_IDLE_MS,
  WHEEL_LINE_PX,
  WHEEL_MAX_PX,
  WHEEL_ZOOM_PER_PX,
  timeWheelIntent,
  wheelIntent,
  windowWheelLatch,
  type WheelIntent,
  type WheelLatch,
} from '../controller/input';

export type Zone = 'plot' | 'x-axis' | 'y-axis' | null;

/**
 * plot: inside the plot rect (edges included). x-axis: below the plot, within its x range.
 * y-axis: left of the plot, within its y range, and only for line and bars. Else null.
 */
export function zoneOf(p: { x: number; y: number }, plot: PlotRect, kind: VisKind): Zone {
  if (!(plot.width > 0) || !(plot.height > 0)) return null;
  const inX = p.x >= plot.x && p.x <= plot.x + plot.width;
  const inY = p.y >= plot.y && p.y <= plot.y + plot.height;
  if (inX && inY) return 'plot';
  if (inX && p.y > plot.y + plot.height) return 'x-axis';
  if (inY && p.x < plot.x && (kind === 'line' || kind === 'bars')) return 'y-axis';
  return null;
}

export type PressKind = 'pan' | 'pan-y' | 'box' | null;

/**
 * The press rows of §4.1: left or middle in the plot or on the x-axis pans time; right, or
 * `Alt`+left, in the plot is the box zoom; left on the y-axis pans values. Touch, and a left press
 * with `Ctrl` but not `⌘` (the macOS secondary click), are not handled.
 */
export function pressKind(
  e: Pick<PointerEvent, 'button' | 'pointerType' | 'altKey' | 'ctrlKey' | 'metaKey'>,
  zone: Zone,
): PressKind {
  if (e.pointerType === 'touch' || zone === null) return null;
  if (e.button === 0 && e.ctrlKey && !e.metaKey) return null;
  switch (zone) {
    case 'plot':
      if (e.button === 2 || (e.button === 0 && e.altKey)) return 'box';
      return e.button === 0 || e.button === 1 ? 'pan' : null;
    case 'x-axis':
      return e.button === 0 || e.button === 1 ? 'pan' : null;
    case 'y-axis':
      return e.button === 0 ? 'pan-y' : null;
  }
}
