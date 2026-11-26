/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_MODE?: 'stub' | 'http';
  readonly VITE_GIT_SHA?: string;
  /** `wasm` selects the WASM engine by default (D-SEL); the URL's `engine` wins. */
  readonly VITE_ENGINE?: string;
  /** `1` in the fault build of the engine e2e suite only (plan #68 C1 §4.3). */
  readonly VITE_ENGINE_FAULTS?: string;
  /** `1` in the probe build of `e2e:shim-fuzz` only, with `VITE_ENGINE_FAULTS` (plan #68 C2a1). */
  readonly VITE_ENGINE_PROBE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare const __APP_VERSION__: string;
