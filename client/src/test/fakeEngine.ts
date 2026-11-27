/**
 * A `ChartEngine` that records calls and lets a test emit frame events, for component tests. Its
 * frames are also engine frames (plan #68 C2a2 §3.2): `setCamera` is recorded, nothing is on
 * screen (`stage()` null).
 */
import type { ChartEngine, ChartFrame, FrameEvents, FrameInit } from '../engine/api';
import { ChartUnsupportedError } from '../engine/canvas2d/Canvas2DEngine';
import type { EngineFrame } from '../engine/wasm/frame';

export interface FakeCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

export interface FakeFrame extends ChartFrame, Omit<EngineFrame, 'on'> {
  readonly canvas: HTMLCanvasElement;
  readonly init: FrameInit;
  readonly calls: FakeCall[];
  disposed: number;
  /** The live listeners of `e` (plan #234 Part 3: the geo host's subscriptions). */
  listening(e: keyof FrameEvents): number;
  /** The events whose listener was removed through its disposer, in order. */
  readonly offs: string[];
  emit<E extends keyof FrameEvents>(e: E, ev: FrameEvents[E]): void;
  last(method: string): readonly unknown[] | undefined;
  /**
   * A completed draw (#90): emits `drawn` with the last `resize` arguments; nothing until a
   * non-empty `resize`.
   */
  draw(): void;
}

export interface FakeEngine extends ChartEngine {
  readonly frames: FakeFrame[];
  readonly createCalls: { canvas: HTMLCanvasElement; init: FrameInit }[];
}

export function fakeEngine(o: { unsupported?: boolean } = {}): FakeEngine {
  const frames: FakeFrame[] = [];
  const createCalls: { canvas: HTMLCanvasElement; init: FrameInit }[] = [];
  return {
    frames,
    createCalls,
    createFrame(canvas: HTMLCanvasElement, init: FrameInit): ChartFrame {
      createCalls.push({ canvas, init });
      if (o.unsupported === true) throw new ChartUnsupportedError('no 2D context');
      const listeners = new Map<string, Set<(ev: never) => void>>();
      const calls: FakeCall[] = [];
      const offs: string[] = [];
      const record =
        (method: string) =>
        (...args: unknown[]): void => {
          calls.push({ method, args });
        };
      const frame: FakeFrame = {
        canvas,
        init,
        calls,
        offs,
        disposed: 0,
        listening: (e) => listeners.get(e)?.size ?? 0,
        setSpec: record('setSpec'),
        setData: record('setData'),
        setTimeWindow: record('setTimeWindow'),
        setTheme: record('setTheme'),
        setEvents: record('setEvents'),
        setSelection: record('setSelection'),
        resize: record('resize'),
        setFocusMark: record('setFocusMark'),
        cameraKey: record('cameraKey'),
        setCamera: record('setCamera'),
        setOverlay: record('setOverlay'),
        select: record('select'),
        stage: () => null,
        onStage: () => () => undefined,
        on(e, cb) {
          let set = listeners.get(e);
          if (set === undefined) {
            set = new Set();
            listeners.set(e, set);
          }
          const fn = cb as (ev: never) => void;
          set.add(fn);
          return () => {
            if (set.delete(fn)) offs.push(e);
          };
        },
        dispose() {
          frame.disposed += 1;
          listeners.clear();
        },
        emit(e, ev) {
          for (const cb of [...(listeners.get(e) ?? [])]) (cb as (x: typeof ev) => void)(ev);
        },
        last(method) {
          return calls.filter((c) => c.method === method).at(-1)?.args;
        },
        draw() {
          const r = frame.last('resize') as readonly [number, number, number] | undefined;
          if (r === undefined || !(r[0] > 0) || !(r[1] > 0)) return;
          frame.emit('drawn', { cssWidth: r[0], cssHeight: r[1], dpr: r[2] });
        },
      };
      frames.push(frame);
      return frame;
    },
  };
}
