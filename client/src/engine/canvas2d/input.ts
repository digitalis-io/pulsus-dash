/** STUB (#93 tests first): input classification. */
import { size } from '../../styles/tokens';
import type { PlotRect, VisKind } from '../api';

export const WHEEL_IDLE_MS = 300;
export const WHEEL_ZOOM_PER_PX = 0.002;
export const PINCH_ZOOM_PER_PX = 0.01;
export const WHEEL_LINE_PX = 16;
export const WHEEL_MAX_PX = 400;
export const DRAG_MIN_PX = size['chart-brush-min'];
export const PAGE_WHEEL_LATCH_MS = 300;

export type Zone = 'plot' | 'x-axis' | 'y-axis' | null;
export function zoneOf(_p: { x: number; y: number }, _plot: PlotRect, _kind: VisKind): Zone {
  return null;
}
export type PressKind = 'pan' | 'pan-y' | 'box' | null;
export function pressKind(
  _e: Pick<PointerEvent, 'button' | 'pointerType' | 'altKey' | 'ctrlKey' | 'metaKey'>,
  _zone: Zone,
): PressKind {
  return null;
}
export type WheelIntent =
  | { readonly kind: 'zoom'; readonly x: boolean; readonly y: boolean; readonly factor: number }
  | { readonly kind: 'panX'; readonly fraction: number };
export function wheelIntent(
  _e: Pick<WheelEvent, 'deltaX' | 'deltaY' | 'deltaMode' | 'shiftKey' | 'ctrlKey' | 'metaKey'>,
  _plot: PlotRect,
): WheelIntent | null {
  return null;
}
export function isPinch(
  _e: Pick<WheelEvent, 'ctrlKey' | 'metaKey' | 'deltaMode' | 'deltaY'>,
): boolean {
  return false;
}
export interface WheelLatch {
  lastPageWheel(): number;
}
export function windowWheelLatch(_target: Pick<Window, 'addEventListener'>): WheelLatch {
  return { lastPageWheel: () => -Infinity };
}
