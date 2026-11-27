/**
 * What the shared camera controller (`controller.ts`, plan #68 C2a2 §3.1; #93, ADR-0020, ADR-0030)
 * needs of the frame it drives: the geometry of the frame on screen (`Stage.model`), and the
 * frame's reactions to camera, hover, click and box-band changes. The Canvas 2D frame implements
 * it over its last drawn layer; `ControlledFrame` over the engine's last completed presentation.
 */
import type { FrameEvents, PlotRect, ValueRange } from '../api';
import type { WheelLatch } from './input';

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** The frame on screen: its plot, its value domain (null: no value axis), band and pick count. */
export interface StageModel {
  readonly plot: PlotRect;
  readonly valueDomain: ValueRange | null;
  readonly labelW: number;
  readonly pickCount: number;
}

export interface Stage {
  /** The frame on screen; null: nothing drawn (the controller ignores every gesture). */
  model(): StageModel | null;
  /** The camera state changed: draw it. */
  redraw(): void;
  /** The pointer or key target changed: the hover follows. */
  hover(): void;
  /** A layout input changed: a shown hover becomes null. */
  clearHover(): void;
  /** A click at `p` in the plot. */
  select(p: Point): void;
  /** The box band moved, appeared or went. */
  boxChanged(): void;
}

/**
 * A bar chart's pointer and key input (ADR-0028, ADR-0029), handed the events the controller does
 * not handle. `down` is true for a press that may brush: the controller captures its pointer.
 */
export interface BarHooks {
  down(e: PointerEvent, p: Point): boolean;
  move(e: PointerEvent, p: Point): void;
  up(e: PointerEvent, p: Point): void;
  cancel(): void;
  clearMark(): void;
  /** The pointer left the chart: the keyboard mark returns while the key target is focused. */
  leave(): void;
  /** A keydown, `focus` and `focusout` on the key target (the mirror listbox, ADR-0029). */
  key(e: KeyboardEvent): void;
  focus(): void;
  blur(): void;
  dispose(): void;
}

export type Emit = <E extends keyof FrameEvents>(e: E, ev: FrameEvents[E]) => void;

export interface ControllerDeps {
  now(): number;
  setTimer(cb: () => void, ms: number): number;
  clearTimer(id: number): void;
  wheelLatch: WheelLatch;
  /** `brush`, `commit`, `select` and `hover` go out through it. */
  emit: Emit;
}
