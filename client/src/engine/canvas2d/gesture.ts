/**
 * The Canvas 2D frame's gesture state and small helpers (#93, ADR-0020, ADR-0025): the wheel and
 * press gestures, DOM listener entries, the spec's value pin and the selection's equality. Split
 * from `Canvas2DEngine.ts` to keep that file within the size limit.
 */
import type { FrameSelection, TimeWindow, ValueRange, VisSpec } from '../api';
import type { Span } from './camera';
import type { Zone } from './input';

export type Listener = (ev: never) => void;
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

/** The axes a gesture moved; set by its preview steps, never reset during the gesture. */
export interface Changed {
  x: boolean;
  y: boolean;
}

/** A wheel, swipe or pinch gesture; `scale` is the last Safari gesture scale while one runs. */
export interface WheelGesture {
  readonly kind: 'wheel';
  timer: number;
  x: number;
  y: number;
  readonly changed: Changed;
  scale: number | null;
}

/** A handled press: time pan, value pan or box zoom. */
export interface PressGesture {
  readonly kind: 'press';
  readonly press: 'pan' | 'pan-y' | 'box';
  readonly zone: Zone;
  readonly pointerId: number;
  readonly x0: number;
  readonly y0: number;
  x: number;
  y: number;
  moved: boolean;
  /** A left press with no modifier in the plot: a click when it ends with `travel` < DRAG_MIN_PX. */
  readonly click: boolean;
  /** The largest Euclidean distance from the press point over every move and the release. */
  travel: number;
  readonly view0: Span;
  readonly value0: ValueRange | null;
  readonly domain0: ValueRange | null;
  readonly changed: Changed;
}

export type Gesture = WheelGesture | PressGesture;

export const spanOf = (w: TimeWindow): Span => ({ lo: w.fromMs, hi: w.toMs });

/** A spec's value-axis pin when it is one the engine draws (line, bars; finite, min < max). */
export function rangeOf(spec: VisSpec | null): ValueRange | null {
  if (spec === null || (spec.kind !== 'line' && spec.kind !== 'bars')) return null;
  const r = spec.valueRange;
  if (r === undefined || !Number.isFinite(r.min) || !Number.isFinite(r.max) || !(r.min < r.max))
    return null;
  return r;
}

export const sameRange = (a: ValueRange | null, b: ValueRange | null): boolean =>
  a === b || (a !== null && b !== null && a.min === b.min && a.max === b.max);

/** Safari's `GestureEvent.scale` (not in the DOM types); 1 when absent. */
export function gestureScale(e: Event): number {
  const s = (e as Event & { scale?: unknown }).scale;
  return typeof s === 'number' && s > 0 ? s : 1;
}

/** Equal keys (in order) and interval; null equals only null. */
export function sameSelection(a: FrameSelection | null, b: FrameSelection | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return (
    a.fromMs === b.fromMs &&
    a.toMs === b.toMs &&
    a.keys.length === b.keys.length &&
    a.keys.every((k, i) => k === b.keys[i])
  );
}
