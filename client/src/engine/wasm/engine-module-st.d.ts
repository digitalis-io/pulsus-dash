/**
 * The types of `virtual:dash-engine-st` (plan #68 C2d2 §2, `config/dashEngine.ts`): the
 * single-thread engine's wasm-bindgen glue (`dash_core_st.d.ts`, committed and compared with every
 * build by `ci:engine-gen`) and the URL of its wasm, null in a build without the engine.
 */
export * from './dash_core_st';
export { default } from './dash_core_st';
export declare const wasmUrl: string | null;
