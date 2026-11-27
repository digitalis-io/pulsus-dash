/* tslint:disable */
/* eslint-disable */

/**
 * What `engine_start` returns: the runtime status (1 T1, 2 T2, 4 Failed) and the control block's
 * address.
 */
export class BootStatus {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * The adapter (`<html data-dash-adapter>`); "" when the GPU did not start.
     */
    readonly adapter: string;
    cb: number;
    status: number;
}

/**
 * One input batch of the single-thread engine (plan #68 C2d2 §3.2): its records are decoded
 * (`input::drain_batch`) and queued, and the next tick applies them first (T03-019). A bad record
 * counts in `INPUT_BAD` and skips the rest of the batch. Returns the records queued.
 */
export function engine_input_batch(bytes: Uint8Array | number[]): number;

/**
 * The function that schedules the next animation frame; called when the engine needs a tick
 * outside the frame loop (device loss, restore).
 */
export function engine_on_wake(wake: Function): void;

/**
 * Allocates the control block and starts the GPU: WebGPU (status 1) unless `force_t2`, else
 * or failing that WebGL2 (status 2); neither is status 4.
 */
export function engine_start(force_t2: boolean, caps_bits: number, epoch: number): Promise<BootStatus>;

/**
 * One animation frame at `now_ms` (main time origin): the events as a JSON array, or "".
 */
export function engine_tick(now_ms: number): string;

/**
 * Whether another animation frame is needed (dirty, awaiting a read-back, events queued, or a
 * device loss); otherwise the worker goes idle unless the input ring has records
 * (`input::before_sleep`): then it ticks again.
 */
export function engine_wants_frame(): boolean;

/**
 * A new engine frame on its transferred canvas.
 */
export function frame_create(id: number, canvas: OffscreenCanvas, frame_id?: string | null): void;

/**
 * Whether the frame's next data fades in over its current one (ADR-0039): called before every
 * `data` and `data-chunk`; false cuts.
 */
export function frame_crossfade(id: number, on: boolean): void;

export function frame_data_begin(id: number): void;

export function frame_data_clear(id: number): void;

/**
 * Ends the frame's data: the chunk becomes the frame's data (`Frames::set_chunk`).
 */
export function frame_data_end(id: number): void;

/**
 * One series of the frame's data: `key` is 16 lower-case hex digits; `names` and `values` are
 * the labels; `t_ms` and `v` have the same length.
 */
export function frame_data_series(id: number, key: string, names: string[], values: string[], t_ms: Float64Array | number[], v: Float64Array | number[]): void;

export function frame_dispose(id: number): void;

/**
 * The frame's event markers' times, ms (`EventMarker.atMs` in call order, NaN kept; plan #68 C2c1
 * §3.3): a layer input, so the frame is rebuilt.
 */
export function frame_set_events(id: number, at_ms: Float64Array | number[]): void;

/**
 * The line's auto-fit window (#304 §A.3): the summary and the auto domain over
 * `from_ms ≤ t ≤ to_ms` only; both None = every sample. Posted before the frame's data.
 */
export function frame_set_fit(id: number, from_ms?: number | null, to_ms?: number | null): void;

/**
 * The page selection (plan #68 C2c2 §3.1): its keys (only 16 lower-case hex digits can match a
 * series key), and its interval; a layer input, so the frame is rebuilt.
 */
export function frame_set_selection(id: number, keys: string[], from_ms?: number | null, to_ms?: number | null): void;

export function frame_set_spec(id: number, json: string): void;

/**
 * 0 dark, 1 light.
 */
export function frame_set_theme(id: number, theme: number): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_bootstatus_free: (a: number, b: number) => void;
    readonly __wbg_get_bootstatus_cb: (a: number) => number;
    readonly __wbg_get_bootstatus_status: (a: number) => number;
    readonly __wbg_set_bootstatus_cb: (a: number, b: number) => void;
    readonly __wbg_set_bootstatus_status: (a: number, b: number) => void;
    readonly bootstatus_adapter: (a: number) => [number, number];
    readonly engine_input_batch: (a: number, b: number) => number;
    readonly engine_on_wake: (a: any) => void;
    readonly engine_start: (a: number, b: number, c: number) => any;
    readonly engine_tick: (a: number) => [number, number];
    readonly engine_wants_frame: () => number;
    readonly frame_create: (a: number, b: any, c: number, d: number) => [number, number];
    readonly frame_crossfade: (a: number, b: number) => void;
    readonly frame_data_begin: (a: number) => void;
    readonly frame_data_clear: (a: number) => void;
    readonly frame_data_end: (a: number) => [number, number];
    readonly frame_data_series: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => [number, number];
    readonly frame_dispose: (a: number) => void;
    readonly frame_set_events: (a: number, b: number, c: number) => void;
    readonly frame_set_fit: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly frame_set_selection: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly frame_set_spec: (a: number, b: number, c: number) => [number, number];
    readonly frame_set_theme: (a: number, b: number) => void;
    readonly wasm_bindgen_c668c5b1fab83e48___convert__closures_____invoke___js_sys_d91882e5995570d3___Function_fn_wasm_bindgen_c668c5b1fab83e48___JsValue_____wasm_bindgen_c668c5b1fab83e48___sys__Undefined___js_sys_d91882e5995570d3___Function_fn_wasm_bindgen_c668c5b1fab83e48___JsValue_____wasm_bindgen_c668c5b1fab83e48___sys__Undefined_______true_: (a: number, b: number, c: any, d: any) => void;
    readonly wasm_bindgen_c668c5b1fab83e48___convert__closures_____invoke___wasm_bindgen_c668c5b1fab83e48___JsValue__core_28b6126153244bc8___result__Result_____wasm_bindgen_c668c5b1fab83e48___JsError___true_: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen_c668c5b1fab83e48___convert__closures_____invoke___wasm_bindgen_c668c5b1fab83e48___sys__JsNullable_wgpu_e7347bf7fa5e5f17___backend__webgpu__webgpu_sys__gen_GpuError__GpuError___core_28b6126153244bc8___result__Result_____wasm_bindgen_c668c5b1fab83e48___JsError___true_: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen_c668c5b1fab83e48___convert__closures_____invoke___wasm_bindgen_c668c5b1fab83e48___sys__JsNullable_wgpu_e7347bf7fa5e5f17___backend__webgpu__webgpu_sys__gen_GpuError__GpuError___core_28b6126153244bc8___result__Result_____wasm_bindgen_c668c5b1fab83e48___JsError___true__27: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen_c668c5b1fab83e48___convert__closures_____invoke___wasm_bindgen_c668c5b1fab83e48___sys__JsNullable_wgpu_e7347bf7fa5e5f17___backend__webgpu__webgpu_sys__gen_GpuError__GpuError___core_28b6126153244bc8___result__Result_____wasm_bindgen_c668c5b1fab83e48___JsError___true__28: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen_c668c5b1fab83e48___convert__closures_____invoke___wgpu_e7347bf7fa5e5f17___backend__webgpu__webgpu_sys__gen_GpuDeviceLostInfo__GpuDeviceLostInfo______true_: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_c668c5b1fab83e48___convert__closures_____invoke___wgpu_e7347bf7fa5e5f17___backend__webgpu__webgpu_sys__gen_GpuDeviceLostInfo__GpuDeviceLostInfo______true__26: (a: number, b: number, c: any) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_destroy_closure: (a: number, b: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __externref_drop_slice: (a: number, b: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
