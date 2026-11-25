/** Messages between the main thread and the engine workers (plan #68 C1 §3.5). */
import type { DrawnEvent, FrameSummary } from '../api';

export interface SeriesMessage {
  readonly key: string;
  readonly names: readonly string[];
  readonly values: readonly string[];
  readonly t: Float64Array;
  readonly v: Float64Array;
}

export type MainToRender =
  | { readonly t: 'create'; readonly id: number; readonly canvas: OffscreenCanvas; readonly frameId: string | null }
  | { readonly t: 'spec'; readonly id: number; readonly json: string }
  | { readonly t: 'data'; readonly id: number; readonly series: readonly SeriesMessage[] | null }
  | { readonly t: 'window'; readonly id: number; readonly from: number; readonly to: number }
  | { readonly t: 'theme'; readonly id: number; readonly theme: 0 | 1 }
  | { readonly t: 'resize'; readonly id: number; readonly w: number; readonly h: number; readonly dpr: number }
  | { readonly t: 'dispose'; readonly id: number };

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
  | { readonly t: 'failed'; readonly id: number; readonly reason: 'surface' | 'readback' };
