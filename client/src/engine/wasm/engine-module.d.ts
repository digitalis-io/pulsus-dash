/**
 * The types of `virtual:dash-engine` (plan #68 C1 §2, `vite.config.ts`): the wasm-bindgen glue
 * (`dash_core_mt.d.ts`, committed and compared with every build by `ci:engine-gen`) and the URL of
 * the engine wasm, null in a build without the engine (`absent.ts`).
 */
export * from './dash_core_mt';
export { default } from './dash_core_mt';
export declare const wasmUrl: string | null;
