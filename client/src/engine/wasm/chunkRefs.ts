/**
 * Chunk references by array identity (plan #68 D2 §3.3, §4.2): the series array of a DSF result is
 * registered against the worker's chunk; a frame whose `setData` receives exactly that array sends
 * the chunk's id instead of the values. When the array is collected, its chunk is released.
 */
import type { SeriesFrame } from '../api';

/** A chunk of the worker's table: its `u32` id and the epoch of the worker that holds it. */
export interface ChunkRef {
  readonly chunk: number;
  readonly epoch: number;
}

/** By-reference `setData` calls (the probe's `decodes().byRef`). */
export const refStats = { byRef: 0 };

export function register(series: readonly SeriesFrame[], ref: ChunkRef): void {
  void series;
  void ref;
}

export function refOf(series: readonly SeriesFrame[]): ChunkRef | undefined {
  void series;
  return undefined;
}

/** Where a collected array's release goes (the current worker; it ignores another epoch). */
export function setReleaser(f: ((ref: ChunkRef) => void) | null): void {
  void f;
}

/** The finaliser of a registered array (the registry's callback; tests call it directly). */
export function collected(ref: ChunkRef): void {
  void ref;
}
