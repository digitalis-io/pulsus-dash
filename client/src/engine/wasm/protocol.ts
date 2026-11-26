/**
 * Messages between the main thread and the engine workers (plan #68 C1 §3.5, C2a1 §3.4), tagged
 * `t`.
 *
 * Main → render: `boot`, then per frame `create` (the canvas transferred), `spec`, `data` (series
 * cloned; heatmap and scalar data `null`), `theme` (0 dark, 1 light), `events` (the markers'
 * times, plan #68 C2c1) and `dispose`; `input` wakes
 * an idle worker after a publish to the input ring (the camera and the size travel there,
 * `ring.ts`). Render → main: `status` (after `engine_start`, with the shared memory), `spawn-pool`
 * (one per pool thread) and `events` (one JSON array per animation frame). Main → pool: `pool`.
 * The probe build adds `probe-input` both ways (the worker's decoded records, `e2e:shim-fuzz`).
 */
import type { DrawnEvent, FrameSummary, HoverEvent, HoverItem, PlotRect, ValueRange } from '../api';

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
  /** Fault builds only: the fault's name (`engine/faults.ts`). */
  readonly fault?: string;
  /** The probe build only: the input ring's counters start here (`engine_probe_ring_start`). */
  readonly ringStart?: number;
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
  | { readonly t: 'theme'; readonly id: number; readonly theme: 0 | 1 }
  /** Plan #68 C2c1: every `EventMarker.atMs` of a `setEvents`, in call order (NaN kept). */
  | { readonly t: 'events'; readonly id: number; readonly atMs: Float64Array }
  /** Plan #68 C2c2: the page selection's keys and interval (`null` → no keys, no interval). */
  | {
      readonly t: 'selection';
      readonly id: number;
      readonly keys: readonly string[];
      readonly fromMs: number | null;
      readonly toMs: number | null;
    }
  | { readonly t: 'dispose'; readonly id: number }
  /** A record was published while the worker was idle (T03-004 revised). */
  | { readonly t: 'input' }
  /** The probe build: post the decoded input records back. */
  | { readonly t: 'probe-input' }
  /** The probe build (plan #68 C2b §3.4): hold the frame after its presentation of `seq`. */
  | { readonly t: 'probe-freeze'; readonly id: number; readonly seq: number }
  | { readonly t: 'probe-unfreeze'; readonly id: number }
  /** The probe build (plan #68 C2c2 S11): drop every renderer and redraw, as after a device loss. */
  | { readonly t: 'probe-renew' };

export type RenderToMain =
  | {
      readonly t: 'status';
      readonly status: number;
      readonly adapter: string;
      readonly cb: number;
      readonly memory: WebAssembly.Memory;
    }
  | { readonly t: 'spawn-pool'; readonly ptr: number }
  | { readonly t: 'events'; readonly json: string }
  /** The probe build: `engine_probe_input()`, a JSON array of `InputRec`. */
  | { readonly t: 'probe-input'; readonly json: string };

export interface PoolMessage {
  readonly t: 'pool';
  readonly module: WebAssembly.Module;
  readonly memory: WebAssembly.Memory;
  readonly ptr: number;
}

/** A presentation's stage as the worker reports it. */
export interface StageWire {
  readonly plot: PlotRect;
  readonly domain: ValueRange | null;
  readonly labelW: number;
  /** Samples of series 0 (plan #68 C2b §3.3): the keyboard crosshair's range. */
  readonly pickCount: number;
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
      /** The frame's last applied seq when this presentation was submitted (plan #68 C2a1 §3.4). */
      readonly seq: number;
      /** The seq of its last applied Resize. */
      readonly rseq: number;
    }
  /**
   * The stage of the frame's last completed presentation of its current Resize (plan #68 C2a2
   * §3.3): its plot, value domain and value-label band, CSS px; null: no plot. Before its `drawn`.
   */
  | {
      readonly t: 'stage';
      readonly id: number;
      readonly rseq: number;
      readonly stage: StageWire | null;
    }
  /**
   * The hover of the frame's last applied Overlay (plan #68 C2b §3.3), from the build of the tick
   * that applied it; `oseq` is that record's seq.
   */
  | {
      readonly t: 'hover';
      readonly id: number;
      readonly oseq: number;
      readonly ev: HoverEvent | null;
    }
  /** A Select record answered against the presentation on screen. */
  | { readonly t: 'select'; readonly id: number; readonly item: HoverItem | null }
  /** `frame_create` succeeded: the frame's records may be published (plan #68 C2a1 §3.1). */
  | { readonly t: 'created'; readonly id: number }
  /** The last seq of the frame's records applied in one tick (the ack, §3.1). */
  | { readonly t: 'applied'; readonly id: number; readonly seq: number }
  | { readonly t: 'failed'; readonly id: number; readonly reason: 'surface' | 'readback' | 'tier' }
  /** A device restore changed the engine's tier; the frames on the old tier report `failed{tier}`. */
  | {
      readonly t: 'tier';
      readonly tier: 't1' | 't2';
      /** T03 §9.3: 1 WebGPU, 2 WebGL2. */
      readonly status: number;
      readonly adapter: string;
    }
  /** The engine cannot go on (a second device loss within 60 s): as a second trap. */
  | { readonly t: 'fatal'; readonly reason: string };

/** The events addressed to one frame. */
export type FrameEvent = Exclude<RenderEvent, { readonly t: 'fatal' } | { readonly t: 'tier' }>;
