/**
 * `virtual:dash-engine` in the unit tests only (`absentEngine` in `vitest.config.ts`; plan #256
 * §3.3): the same exports, none of them usable, because unit tests never load the engine. A build or
 * dev server without the engine refuses to run instead (ADR-0031). The adapter sees
 * `wasmUrl === null` and fails with `EngineAbsent`, which does not mark the session.
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
