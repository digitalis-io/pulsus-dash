/**
 * A `Ctx2D` that records every call with the style in effect, for engine tests. `measureText` is
 * fixed at 7 px per character, so layouts are deterministic.
 */
import type { Ctx2D } from '../engine/canvas2d/ctx';

export interface RecordedOp {
  readonly op: string;
  readonly args: readonly unknown[];
  readonly fillStyle: string;
  readonly strokeStyle: string;
  readonly lineWidth: number;
  readonly font: string;
  readonly textAlign: string;
}

export interface RecordingContext extends Ctx2D {
  readonly ops: RecordedOp[];
  clearOps(): void;
  /** The ops named `op`. */
  calls(op: string): RecordedOp[];
}

export const CHAR_WIDTH = 7;

export function recordingContext(): RecordingContext {
  const ops: RecordedOp[] = [];
  const state = {
    fillStyle: '' as string | CanvasGradient | CanvasPattern,
    strokeStyle: '' as string | CanvasGradient | CanvasPattern,
    lineWidth: 1,
    lineJoin: 'miter' as CanvasLineJoin,
    lineCap: 'butt' as CanvasLineCap,
    font: '10px sans-serif',
    textAlign: 'start' as CanvasTextAlign,
    textBaseline: 'alphabetic' as CanvasTextBaseline,
  };
  const stack: (typeof state)[] = [];
  const text = (v: string | CanvasGradient | CanvasPattern): string =>
    typeof v === 'string' ? v : 'gradient-or-pattern';
  const rec =
    (op: string) =>
    (...args: unknown[]): void => {
      ops.push({
        op,
        args,
        fillStyle: text(state.fillStyle),
        strokeStyle: text(state.strokeStyle),
        lineWidth: state.lineWidth,
        font: state.font,
        textAlign: state.textAlign,
      });
    };
  const ctx = {
    get fillStyle() {
      return state.fillStyle;
    },
    set fillStyle(v) {
      state.fillStyle = v;
    },
    get strokeStyle() {
      return state.strokeStyle;
    },
    set strokeStyle(v) {
      state.strokeStyle = v;
    },
    get lineWidth() {
      return state.lineWidth;
    },
    set lineWidth(v) {
      state.lineWidth = v;
    },
    get lineJoin() {
      return state.lineJoin;
    },
    set lineJoin(v) {
      state.lineJoin = v;
    },
    get lineCap() {
      return state.lineCap;
    },
    set lineCap(v) {
      state.lineCap = v;
    },
    get font() {
      return state.font;
    },
    set font(v) {
      state.font = v;
    },
    get textAlign() {
      return state.textAlign;
    },
    set textAlign(v) {
      state.textAlign = v;
    },
    get textBaseline() {
      return state.textBaseline;
    },
    set textBaseline(v) {
      state.textBaseline = v;
    },
    setTransform: rec('setTransform'),
    fillRect: rec('fillRect'),
    clearRect: rec('clearRect'),
    beginPath: rec('beginPath'),
    moveTo: rec('moveTo'),
    lineTo: rec('lineTo'),
    arc: rec('arc'),
    fill: rec('fill'),
    stroke: rec('stroke'),
    fillText: rec('fillText'),
    drawImage: rec('drawImage'),
    save() {
      stack.push({ ...state });
      rec('save')();
    },
    restore() {
      const s = stack.pop();
      if (s !== undefined) Object.assign(state, s);
      rec('restore')();
    },
    measureText(s: string): TextMetrics {
      return { width: CHAR_WIDTH * s.length } as TextMetrics;
    },
    ops,
    clearOps() {
      ops.length = 0;
    },
    calls(op: string) {
      return ops.filter((o) => o.op === op);
    },
  };
  return ctx;
}
