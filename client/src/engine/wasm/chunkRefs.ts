/**
 * Chunk references by array identity (plan #68 D2 §3.3, §4.2): the series array of a DSF result is
 * registered against the worker's chunk (a `WeakMap`, so the array alone decides its life); a frame
 * whose `setData` receives exactly that array sends the chunk's id instead of the values. A copy, a
 * filtered or merged list is another array and goes by value. When the registered array is
 * collected, a `FinalizationRegistry` releases its chunk on the current worker, which ignores a
 * release of another epoch (a finaliser that runs after a restart).
 */
import type { SeriesFrame } from '../api';

/** A chunk of the worker's table: its `u32` id and the epoch of the worker that holds it. */
export interface ChunkRef {
  readonly chunk: number;
  readonly epoch: number;
}

/** By-reference `setData` calls (the probe's `decodes().byRef`). */
export const refStats = { byRef: 0 };

const refs = new WeakMap<readonly SeriesFrame[], ChunkRef>();
let releaser: ((ref: ChunkRef) => void) | null = null;

/** The finaliser of a registered array (the registry's callback; tests call it directly). */
export function collected(ref: ChunkRef): void {
  releaser?.(ref);
}

const registry =
  typeof FinalizationRegistry === 'undefined'
    ? null
    : new FinalizationRegistry<ChunkRef>((ref) => {
        collected(ref);
      });

/** `series` (by identity) is the chunk `ref` of the worker's table. */
export function register(series: readonly SeriesFrame[], ref: ChunkRef): void {
  if (refs.has(series)) return;
  refs.set(series, ref);
  registry?.register(series, ref);
}

/** The chunk `series` is, if it is a registered array. */
export function refOf(series: readonly SeriesFrame[]): ChunkRef | undefined {
  return refs.get(series);
}

/** Where a collected array's release goes (the current worker; it ignores another epoch). */
export function setReleaser(f: ((ref: ChunkRef) => void) | null): void {
  releaser = f;
}
