/**
 * Messages between the main thread and the engine workers (plan #68 C1 §3.5), tagged `t`.
 *
 * Main → render: `boot`, then per frame `create` (the canvas transferred), `spec`, `data` (series
 * cloned; heatmap and scalar data `null`), `window`, `theme` (0 dark, 1 light), `resize` and
 * `dispose`. Render → main: `status` (after `engine_start`, with the shared memory), `spawn-pool`
 * (one per pool thread) and `events` (one JSON array per animation frame). Main → pool: `pool`.
 */
import type { DrawnEvent, FrameSummary } from '../api';

/** A test fault of the fault build (`wasm/faults.ts`). */
export type Fault = 'surface' | 'trap' | 'trap2' | 'gap';

export interface SeriesMessage {
  readonly key: string;
  readonly names: readonly string[];
  readonly values: readonly string[];
  readonly t: Float64Array;
  readonly v: Float64Array;
}

export interface BootMessage {
  readonly t: 'boot';
  readonly module: WebAssembly.Module;
  readonly forceT2: boolean;
  /** T03 §9.1 capability bits (`layout.gen.ts` `CAP_*`). */
  readonly caps: number;
  /** `performance.timeOrigin` of the main thread: worker times are reported on it. */
  readonly mainTimeOrigin: number;
  /** Pool threads. */
  readonly pool: number;
  /** Fault builds only. */
  readonly fault?: Fault;
}

export type MainToRender =
  | BootMessage
  | {
      readonly t: 'create';
      readonly id: number;
      readonly canvas: OffscreenCanvas;
      readonly frameId: string | null;
    }
  | { readonly t: 'spec'; readonly id: number; readonly json: string }
  | { readonly t: 'data'; readonly id: number; readonly series: readonly SeriesMessage[] | null }
  | { readonly t: 'window'; readonly id: number; readonly from: number; readonly to: number }
  | { readonly t: 'theme'; readonly id: number; readonly theme: 0 | 1 }
  | {
      readonly t: 'resize';
      readonly id: number;
      readonly w: number;
      readonly h: number;
      readonly dpr: number;
    }
  | { readonly t: 'dispose'; readonly id: number };

export type RenderToMain =
  | {
      readonly t: 'status';
      readonly status: number;
      readonly adapter: string;
      readonly cb: number;
      readonly memory: WebAssembly.Memory;
    }
  | { readonly t: 'spawn-pool'; readonly ptr: number }
  | { readonly t: 'events'; readonly json: string };

export interface PoolMessage {
  readonly t: 'pool';
  readonly module: WebAssembly.Module;
  readonly memory: WebAssembly.Memory;
  readonly ptr: number;
}

export type RenderEvent =
  | { readonly t: 'a11y'; readonly id: number; readonly ev: FrameSummary }
  | {
      readonly t: 'drawn';
      readonly id: number;
      readonly ev: DrawnEvent;
      readonly startMs: number;
      readonly endMs: number;
      readonly series: number;
    }
  | { readonly t: 'failed'; readonly id: number; readonly reason: 'surface' | 'readback' }
  /** The engine cannot go on (a second device loss within 60 s): as a second trap. */
  | { readonly t: 'fatal'; readonly reason: string };

/** The events addressed to one frame. */
export type FrameEvent = Exclude<RenderEvent, { readonly t: 'fatal' }>;
