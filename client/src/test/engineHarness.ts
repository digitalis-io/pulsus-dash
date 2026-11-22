/**
 * Drives a `Canvas2DEngine` frame in tests: recording contexts for the visible and layer canvases,
 * a manual frame queue (`flush`), fake timers (`advance`), a test wheel latch, and the events the
 * frame emitted.
 */
import type {
  BrushEvent,
  CommitEvent,
  DrawnEvent,
  FrameData,
  FrameSummary,
  HoverEvent,
  SeriesFrame,
  VisSpec,
} from '../engine/api';
import type { Canvas2DEngine as EngineClass } from '../engine/canvas2d/Canvas2DEngine';
import type { WheelLatch } from '../engine/canvas2d/input';
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
  readonly drawn: DrawnEvent[];
  readonly commit: CommitEvent[];
  /** Moves the fake clock by `ms`, running every timer that falls due, in order. */
  advance(ms: number): void;
  /** Timers armed and not yet run or cleared. */
  timers(): number;
}

export function harness(
  Engine: typeof EngineClass,
  o: { keyTarget?: HTMLElement | null; timeZone?: string; id?: string; latch?: WheelLatch } = {},
): Harness {
  const queue = new Map<number, () => void>();
  let next = 0;
  const timerQueue = new Map<number, { due: number; cb: () => void }>();
  let timerSeq = 0;
  let clock = 0;
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
    setTimer: (cb, ms) => {
      timerSeq += 1;
      timerQueue.set(timerSeq, { due: clock + ms, cb });
      return timerSeq;
    },
    clearTimer: (id) => {
      timerQueue.delete(id);
    },
    // No unconsumed page wheel unless a test says so.
    wheelLatch: o.latch ?? { lastPageWheel: () => -Infinity },
  });
  const canvas = document.createElement('canvas');
  const frame = engine.createFrame(canvas, {
    timeZone: o.timeZone ?? 'Europe/London',
    keyTarget: o.keyTarget ?? null,
    ...(o.id === undefined ? {} : { id: o.id }),
  });
  const a11y: FrameSummary[] = [];
  const hover: (HoverEvent | null)[] = [];
  const brush: BrushEvent[] = [];
  frame.on('a11y', (s) => a11y.push(s));
  frame.on('hover', (h) => hover.push(h));
  frame.on('brush', (b) => brush.push(b));
  const drawn: DrawnEvent[] = [];
  frame.on('drawn', (d) => drawn.push(d));
  const commit: CommitEvent[] = [];
  frame.on('commit', (c) => commit.push(c));
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
    drawn,
    commit,
    advance(ms: number) {
      const end = clock + ms;
      for (;;) {
        let id: number | null = null;
        let due = Infinity;
        for (const [k, t] of timerQueue) {
          if (t.due <= end && t.due < due) {
            id = k;
            due = t.due;
          }
        }
        const t = id === null ? undefined : timerQueue.get(id);
        if (id === null || t === undefined) break;
        timerQueue.delete(id);
        clock = due;
        t.cb();
      }
      clock = end;
    },
    timers: () => timerQueue.size,
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
  o: {
    button?: number;
    buttons?: number;
    altKey?: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
    pointerType?: string;
  } = {},
): Event {
  const init = {
    clientX: x,
    clientY: y,
    button: o.button ?? 0,
    buttons: o.buttons ?? 0,
    altKey: o.altKey ?? false,
    ctrlKey: o.ctrlKey ?? false,
    metaKey: o.metaKey ?? false,
    pointerType: o.pointerType ?? 'mouse',
    pointerId: 1,
    bubbles: true,
    cancelable: true,
  };
  const e =
    type === 'dblclick' || type === 'contextmenu'
      ? new MouseEvent(type, init)
      : new PointerEvent(type, init);
  target.dispatchEvent(e);
  return e;
}

export interface WheelInit {
  deltaX?: number;
  deltaY?: number;
  deltaMode?: number;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  /** Overrides the event's `timeStamp` (the scroll latch compares it). */
  timeStamp?: number;
}

/** A cancelable wheel event at canvas-relative CSS px; returns it (`defaultPrevented`). */
export function wheel(target: EventTarget, x: number, y: number, init: WheelInit = {}): WheelEvent {
  const e = new WheelEvent('wheel', {
    clientX: x,
    clientY: y,
    deltaX: init.deltaX ?? 0,
    deltaY: init.deltaY ?? 0,
    deltaMode: init.deltaMode ?? 0,
    shiftKey: init.shiftKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    bubbles: true,
    cancelable: true,
  });
  if (init.timeStamp !== undefined)
    Object.defineProperty(e, 'timeStamp', { value: init.timeStamp });
  target.dispatchEvent(e);
  return e;
}

/** A Safari `gesturestart` / `gesturechange` / `gestureend` with `scale` and client px. */
export function gesture(
  target: EventTarget,
  type: 'gesturestart' | 'gesturechange' | 'gestureend',
  x: number,
  y: number,
  scale = 1,
): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, { clientX: x, clientY: y, scale });
  target.dispatchEvent(e);
  return e;
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
