/** A `ChartEngine` that records calls and lets a test emit frame events, for component tests. */
import type { ChartEngine, ChartFrame, FrameEvents, FrameInit } from '../engine/api';
import { ChartUnsupportedError } from '../engine/canvas2d/Canvas2DEngine';

export interface FakeCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

export interface FakeFrame extends ChartFrame {
  readonly canvas: HTMLCanvasElement;
  readonly init: FrameInit;
  readonly calls: FakeCall[];
  disposed: number;
  emit<E extends keyof FrameEvents>(e: E, ev: FrameEvents[E]): void;
  last(method: string): readonly unknown[] | undefined;
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
      const record =
        (method: string) =>
        (...args: unknown[]): void => {
          calls.push({ method, args });
        };
      const frame: FakeFrame = {
        canvas,
        init,
        calls,
        disposed: 0,
        setSpec: record('setSpec'),
        setData: record('setData'),
        setTimeWindow: record('setTimeWindow'),
        setTheme: record('setTheme'),
        resize: record('resize'),
        on(e, cb) {
          let set = listeners.get(e);
          if (set === undefined) {
            set = new Set();
            listeners.set(e, set);
          }
          const fn = cb as (ev: never) => void;
          set.add(fn);
          return () => {
            set.delete(fn);
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
      };
      frames.push(frame);
      return frame;
    },
  };
}
