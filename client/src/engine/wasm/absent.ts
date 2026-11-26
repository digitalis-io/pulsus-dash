/**
 * `virtual:dash-engine` in a build without the engine (no `wasm/gen/`, plan #68 C1 §2, R4): the
 * same exports, none of them usable. The adapter sees `wasmUrl === null` and every frame stays on
 * Canvas 2D; `ci:bundle-size` reports `missing-artefact:engine`.
 */
const absent = (): never => {
  throw new Error('the engine is not in this build');
};

export const wasmUrl: string | null = null;
export default absent;
export const initSync = absent;
export const engine_on_wake = absent;
export const engine_start = absent;
export const engine_tick = absent;
export const engine_wants_frame = absent;
export const frame_create = absent;
export const frame_data_begin = absent;
export const frame_data_clear = absent;
export const frame_data_end = absent;
export const frame_data_series = absent;
export const frame_dispose = absent;
export const frame_set_spec = absent;
export const frame_set_theme = absent;
export const pool_run = absent;
export const pool_start = absent;
/** Never constructed: `engine_start` throws first. */
export const BootStatus = absent;
