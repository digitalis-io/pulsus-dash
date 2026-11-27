/**
 * A `Ctx2D` that records every call with the style and the transform in effect, for engine tests.
 * `measureText` is fixed at 7 px per character, so layouts are deterministic. `save`/`restore`
 * keep the style and the transform, as a canvas does.
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
  readonly globalAlpha: number;
  /** The transform `[a, b, c, d, e, f]` in effect (after a `setTransform`, its own). */
  readonly transform: readonly number[];
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
    globalAlpha: 1,
    transform: [1, 0, 0, 1, 0, 0] as number[],
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
        globalAlpha: state.globalAlpha,
        transform: [...state.transform],
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
    get globalAlpha() {
      return state.globalAlpha;
    },
    set globalAlpha(v) {
      state.globalAlpha = v;
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
    setTransform: ((...m: number[]) => {
      state.transform = m.slice(0, 6);
      rec('setTransform')(...m);
    }) as Ctx2D['setTransform'],
    fillRect: rec('fillRect'),
    strokeRect: rec('strokeRect'),
    clearRect: rec('clearRect'),
    beginPath: rec('beginPath'),
    moveTo: rec('moveTo'),
    lineTo: rec('lineTo'),
    closePath: rec('closePath'),
    arc: rec('arc'),
    fill: rec('fill'),
    stroke: rec('stroke'),
    fillText: rec('fillText'),
    drawImage: rec('drawImage'),
    rect: rec('rect'),
    clip: rec('clip'),
    setLineDash: rec('setLineDash'),
    /**
     * A linear gradient (#282 Part 2a): records `createLinearGradient(x0, y0, x1, y1)` and each of
     * its `addColorStop(offset, colour)` calls; a fill with it records `gradient-or-pattern`.
     */
    createLinearGradient(x0: number, y0: number, x1: number, y1: number): CanvasGradient {
      rec('createLinearGradient')(x0, y0, x1, y1);
      return {
        addColorStop(offset: number, c: string) {
          rec('addColorStop')(offset, c);
        },
      };
    },
    /** A pattern object that remembers its tile; a fill with it records `gradient-or-pattern`. */
    createPattern(image: CanvasImageSource, repetition: string | null): CanvasPattern {
      rec('createPattern')(image, repetition);
      return { setTransform: () => undefined, image } as unknown as CanvasPattern;
    },
    rotate(r: number) {
      const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = state.transform;
      const [cos, sin] = [Math.cos(r), Math.sin(r)];
      state.transform = [
        a * cos + c * sin,
        b * cos + d * sin,
        c * cos - a * sin,
        d * cos - b * sin,
        e,
        f,
      ];
      rec('rotate')(r);
    },
    translate(x: number, y: number) {
      const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = state.transform;
      state.transform = [a, b, c, d, e + a * x + c * y, f + b * x + d * y];
      rec('translate')(x, y);
    },
    save() {
      stack.push({ ...state, transform: [...state.transform] });
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
