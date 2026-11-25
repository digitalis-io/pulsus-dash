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
 * Allocates the control block and starts the GPU: WebGPU (status 1) unless `force_t2`, else
 * or failing that WebGL2 (status 2); neither is status 4.
 */
export function engine_start(force_t2: boolean, caps_bits: number, epoch: number): Promise<BootStatus>;

/**
 * One animation frame at `now_ms` (main time origin): the events as a JSON array, or "".
 */
export function engine_tick(now_ms: number): string;

/**
 * Whether another animation frame is needed (dirty, awaiting a read-back, or events queued).
 */
export function engine_wants_frame(): boolean;

/**
 * A new engine frame on its transferred canvas.
 */
export function frame_create(id: number, canvas: OffscreenCanvas, frame_id?: string | null): void;

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
 * CSS px and DPR (a message until C2's input ring carries Resize records).
 */
export function frame_resize(id: number, css_w: number, css_h: number, dpr: number): void;

export function frame_set_spec(id: number, json: string): void;

/**
 * 0 dark, 1 light.
 */
export function frame_set_theme(id: number, theme: number): void;

export function frame_set_window(id: number, from_ms: number, to_ms: number): void;

/**
 * Runs the pool thread `ptr` (from `pool_start`) on this pool worker; returns only when the
 * pool ends.
 */
export function pool_run(ptr: number): void;

/**
 * Installs the global pool of `threads` threads (once per page).
 */
export function pool_start(threads: number, spawn: Function): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly __wbg_bootstatus_free: (a: number, b: number) => void;
    readonly __wbg_get_bootstatus_cb: (a: number) => number;
    readonly __wbg_get_bootstatus_status: (a: number) => number;
    readonly __wbg_set_bootstatus_cb: (a: number, b: number) => void;
    readonly __wbg_set_bootstatus_status: (a: number, b: number) => void;
    readonly bootstatus_adapter: (a: number) => [number, number];
    readonly engine_start: (a: number, b: number, c: number) => any;
    readonly engine_tick: (a: number) => [number, number];
    readonly engine_wants_frame: () => number;
    readonly frame_create: (a: number, b: any, c: number, d: number) => [number, number];
    readonly frame_data_begin: (a: number) => void;
    readonly frame_data_clear: (a: number) => void;
    readonly frame_data_end: (a: number) => [number, number];
    readonly frame_data_series: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => [number, number];
    readonly frame_dispose: (a: number) => void;
    readonly frame_resize: (a: number, b: number, c: number, d: number) => void;
    readonly frame_set_spec: (a: number, b: number, c: number) => [number, number];
    readonly frame_set_theme: (a: number, b: number) => void;
    readonly frame_set_window: (a: number, b: number, c: number) => void;
    readonly pool_run: (a: number) => void;
    readonly pool_start: (a: number, b: any) => [number, number];
    readonly wasm_bindgen_fdf7a4a3b6a46677___convert__closures_____invoke___js_sys_5ad0944f19124a33___Function_fn_wasm_bindgen_fdf7a4a3b6a46677___JsValue_____wasm_bindgen_fdf7a4a3b6a46677___sys__Undefined___js_sys_5ad0944f19124a33___Function_fn_wasm_bindgen_fdf7a4a3b6a46677___JsValue_____wasm_bindgen_fdf7a4a3b6a46677___sys__Undefined_______true_: (a: number, b: number, c: any, d: any) => void;
    readonly wasm_bindgen_fdf7a4a3b6a46677___convert__closures_____invoke___wasm_bindgen_fdf7a4a3b6a46677___JsValue__core_fe68b9cd74b8de19___result__Result_____wasm_bindgen_fdf7a4a3b6a46677___JsError___true_: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen_fdf7a4a3b6a46677___convert__closures_____invoke___wasm_bindgen_fdf7a4a3b6a46677___sys__JsNullable_wgpu_1630092ed8d14337___backend__webgpu__webgpu_sys__gen_GpuError__GpuError___core_fe68b9cd74b8de19___result__Result_____wasm_bindgen_fdf7a4a3b6a46677___JsError___true_: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen_fdf7a4a3b6a46677___convert__closures_____invoke___wasm_bindgen_fdf7a4a3b6a46677___sys__JsNullable_wgpu_1630092ed8d14337___backend__webgpu__webgpu_sys__gen_GpuError__GpuError___core_fe68b9cd74b8de19___result__Result_____wasm_bindgen_fdf7a4a3b6a46677___JsError___true__27: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen_fdf7a4a3b6a46677___convert__closures_____invoke___wasm_bindgen_fdf7a4a3b6a46677___sys__JsNullable_wgpu_1630092ed8d14337___backend__webgpu__webgpu_sys__gen_GpuError__GpuError___core_fe68b9cd74b8de19___result__Result_____wasm_bindgen_fdf7a4a3b6a46677___JsError___true__28: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen_fdf7a4a3b6a46677___convert__closures_____invoke___js_sys_5ad0944f19124a33___futures__task__wait_async_polyfill__MessageEvent______true_: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_fdf7a4a3b6a46677___convert__closures_____invoke___wasm_bindgen_fdf7a4a3b6a46677___JsValue______true_: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_fdf7a4a3b6a46677___convert__closures_____invoke___wasm_bindgen_fdf7a4a3b6a46677___JsValue______true__25: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_fdf7a4a3b6a46677___convert__closures_____invoke___wasm_bindgen_fdf7a4a3b6a46677___JsValue______true__26: (a: number, b: number, c: any) => void;
    readonly memory: WebAssembly.Memory;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_destroy_closure: (a: number, b: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __externref_drop_slice: (a: number, b: number) => void;
    readonly __wbindgen_thread_destroy: (a?: number, b?: number, c?: number) => void;
    readonly __wbindgen_start: (a: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput, memory?: WebAssembly.Memory, thread_stack_size?: number }} module - Passing `SyncInitInput` directly is deprecated.
 * @param {WebAssembly.Memory} memory - Deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput, memory?: WebAssembly.Memory, thread_stack_size?: number } | SyncInitInput, memory?: WebAssembly.Memory): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput>, memory?: WebAssembly.Memory, thread_stack_size?: number }} module_or_path - Passing `InitInput` directly is deprecated.
 * @param {WebAssembly.Memory} memory - Deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path: { module_or_path: InitInput | Promise<InitInput>, memory?: WebAssembly.Memory, thread_stack_size?: number } | InitInput | Promise<InitInput>, memory?: WebAssembly.Memory): Promise<InitOutput>;
