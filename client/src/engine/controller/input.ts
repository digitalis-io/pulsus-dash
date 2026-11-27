/**
 * Renderer-neutral input helpers shared by the cameras (#93, plan #234 Part 2): DOM listener
 * entries, the wheel constants and intent, the pinch heuristic and the page-wheel latch. Pure,
 * apart from the latch's one passive listener. `canvas2d/input.ts` and `canvas2d/gesture.ts`
 * re-export them.
 */
import { size } from '../../styles/tokens';
import type { PlotRect } from '../api';

export type Handler = readonly [string, (e: Event) => void, AddEventListenerOptions | undefined];

/** A DOM listener entry; `fn` receives the event type it is registered for. */
export function listen(
  type: string,
  fn: (e: never) => unknown,
  opts?: AddEventListenerOptions,
): Handler {
  const f = fn as (e: Event) => unknown;
  return [
    type,
    (e) => {
      f(e);
    },
    opts,
  ];
}

/** T02 §4.6: a wheel move is committed after 300 ms with no consumed input. */
export const WHEEL_IDLE_MS = 300;
/** factor = exp(px · k): a 100 px notch → ×1.221. */
export const WHEEL_ZOOM_PER_PX = 0.002;
export const PINCH_ZOOM_PER_PX = 0.01;
/** `deltaMode` 1 (lines). */
export const WHEEL_LINE_PX = 16;
/** |px| per event is clamped to this. */
export const WHEEL_MAX_PX = 400;
/** Below it a press is a click. */
export const DRAG_MIN_PX = size['chart-brush-min'];
export const PAGE_WHEEL_LATCH_MS = 300;

export type WheelIntent =
  | { readonly kind: 'zoom'; readonly x: boolean; readonly y: boolean; readonly factor: number }
  | { readonly kind: 'panX'; readonly fraction: number };

/**
 * ctrlKey && !metaKey && deltaMode === 0 && !Number.isInteger(deltaY): a trackpad pinch
 * (owner-delegated heuristic, issue body 2026-11-21; its misclassifications are accepted).
 */
export function isPinch(
  e: Pick<WheelEvent, 'ctrlKey' | 'metaKey' | 'deltaMode' | 'deltaY'>,
): boolean {
  return e.ctrlKey && !e.metaKey && e.deltaMode === 0 && !Number.isInteger(e.deltaY);
}

/** The wheel rows of §4.1 for a wheel over the plot; `plot` scales deltaMode 2 and panX. */
export function wheelIntent(
  e: Pick<WheelEvent, 'deltaX' | 'deltaY' | 'deltaMode' | 'shiftKey' | 'ctrlKey' | 'metaKey'>,
  plot: PlotRect,
): WheelIntent | null {
  const scale = e.deltaMode === 1 ? WHEEL_LINE_PX : e.deltaMode === 2 ? plot.height : 1;
  const px = (d: number): number => Math.min(WHEEL_MAX_PX, Math.max(-WHEEL_MAX_PX, d * scale));
  const zoom = (x: boolean, y: boolean, d: number, k: number): WheelIntent => ({
    kind: 'zoom',
    x,
    y,
    factor: Math.exp(px(d) * k),
  });
  if (isPinch(e)) return zoom(true, false, e.deltaY, PINCH_ZOOM_PER_PX);
  if (e.ctrlKey || e.metaKey) return zoom(true, true, e.deltaY, WHEEL_ZOOM_PER_PX);
  if (e.shiftKey) return zoom(false, true, e.deltaY !== 0 ? e.deltaY : e.deltaX, WHEEL_ZOOM_PER_PX);
  if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
    return { kind: 'panX', fraction: px(e.deltaX) / plot.width };
  }
  if (e.deltaY !== 0) return zoom(true, false, e.deltaY, WHEEL_ZOOM_PER_PX);
  return null;
}

/** The time of the last wheel event that no chart consumed, for the scroll latch (§4.4). */
export interface WheelLatch {
  lastPageWheel(): number;
}

/** One passive bubbling `wheel` listener on `target`: records `e.timeStamp` when not prevented. */
export function windowWheelLatch(target: Pick<Window, 'addEventListener'>): WheelLatch {
  let last = -Infinity;
  target.addEventListener(
    'wheel',
    (e: Event) => {
      if (!e.defaultPrevented) last = e.timeStamp;
    },
    { passive: true },
  );
  return { lastPageWheel: () => last };
}
