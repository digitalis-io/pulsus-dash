/**
 * Drives a `Canvas2DEngine` frame in tests: recording contexts for the visible and layer canvases,
 * a manual frame queue (`flush`), and the events the frame emitted.
 */
import type {
  BrushEvent,
  FrameData,
  FrameSummary,
  HoverEvent,
  SeriesFrame,
  VisSpec,
} from '../engine/api';
import type { Canvas2DEngine as EngineClass } from '../engine/canvas2d/Canvas2DEngine';
import { recordingContext, type RecordingContext } from './recordingContext';

export interface Harness {
  readonly canvas: HTMLCanvasElement;
  readonly frame: ReturnType<EngineClass['createFrame']>;
  /** Runs every queued frame callback. */
  flush(): void;
  queued(): number;
  /** The layer canvas's context (marks), and the visible canvas's (blit and overlay). */
  layer(): RecordingContext;
  visible(): RecordingContext;
  readonly a11y: FrameSummary[];
  readonly hover: (HoverEvent | null)[];
  readonly brush: BrushEvent[];
}

export function harness(
  Engine: typeof EngineClass,
  o: { keyTarget?: HTMLElement | null; timeZone?: string } = {},
): Harness {
  const queue = new Map<number, () => void>();
  let next = 0;
  const contexts = new Map<HTMLCanvasElement, RecordingContext>();
  const layers: HTMLCanvasElement[] = [];
  const engine = new Engine({
    requestFrame: (cb) => {
      next += 1;
      queue.set(next, cb);
      return next;
    },
    cancelFrame: (id) => {
      queue.delete(id);
    },
    contextOf: (c) => {
      const r = recordingContext();
      contexts.set(c, r);
      return r;
    },
    createCanvas: () => {
      const c = document.createElement('canvas');
      layers.push(c);
      return c;
    },
    fonts: null,
    now: () => 0,
  });
  const canvas = document.createElement('canvas');
  const frame = engine.createFrame(canvas, {
    timeZone: o.timeZone ?? 'Europe/London',
    keyTarget: o.keyTarget ?? null,
  });
  const a11y: FrameSummary[] = [];
  const hover: (HoverEvent | null)[] = [];
  const brush: BrushEvent[] = [];
  frame.on('a11y', (s) => a11y.push(s));
  frame.on('hover', (h) => hover.push(h));
  frame.on('brush', (b) => brush.push(b));
  const ctxOf = (c: HTMLCanvasElement | undefined): RecordingContext => {
    const r = c === undefined ? undefined : contexts.get(c);
    if (r === undefined) throw new Error('no recording context');
    return r;
  };
  return {
    canvas,
    frame,
    flush() {
      for (let guard = 0; guard < 10 && queue.size > 0; guard++) {
        const cbs = [...queue.values()];
        queue.clear();
        for (const cb of cbs) cb();
      }
    },
    queued: () => queue.size,
    layer: () => ctxOf(layers[0]),
    visible: () => ctxOf(canvas),
    a11y,
    hover,
    brush,
  };
}

export function seriesFrame(
  key: string,
  ts: readonly number[],
  vs: readonly number[],
  labels: Readonly<Record<string, string>> = {},
): SeriesFrame {
  return { key, labels, timestamps: new Float64Array(ts), values: new Float64Array(vs) };
}

export const seriesData = (...s: SeriesFrame[]): FrameData => ({ kind: 'series', series: s });

export const LINE_NONE: VisSpec = { kind: 'line', title: 'T', unit: { kind: 'none' } };

/** Pointer and mouse events at canvas-relative CSS px (jsdom's bounding box is at 0, 0). */
export function pointer(
  target: EventTarget,
  type: string,
  x: number,
  y: number,
  o: { button?: number; buttons?: number } = {},
): void {
  const init = {
    clientX: x,
    clientY: y,
    button: o.button ?? 0,
    buttons: o.buttons ?? 0,
    pointerId: 1,
    bubbles: true,
    cancelable: true,
  };
  target.dispatchEvent(
    type === 'dblclick' ? new MouseEvent(type, init) : new PointerEvent(type, init),
  );
}

export function key(target: EventTarget, k: string, o: { ctrlKey?: boolean } = {}): KeyboardEvent {
  const e = new KeyboardEvent('keydown', {
    key: k,
    ctrlKey: o.ctrlKey ?? false,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(e);
  return e;
}
