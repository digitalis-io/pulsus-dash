/**
 * `virtual:dash-engine` (plan #68 C1 §2; plan #256 §3.3, ADR-0031): the wasm-bindgen glue of
 * `cargo xtask build-wasm` in the git-ignored `src/engine/wasm/gen/` with the URL of its wasm. With
 * `VITE_ENGINE_PROBE=1` (the probe build of `e2e:shim-fuzz`, plan #68 C2a1 §3.5) it is the `--probe`
 * engine in `src/engine/wasm/gen-probe/` instead. Types: `src/engine/wasm/engine-module.d.ts`.
 *
 * The engine is the default renderer, so every build and dev server includes it: without its two
 * files `vite build` fails at `buildStart` and the dev server refuses to start, naming the `make`
 * target that builds it. `VITE_ENGINE=canvas2d` is a renderer override, not an opt-out. Only the
 * test runner (`VITEST` set) resolves the module to `src/engine/wasm/absent.ts`: unit tests never
 * load the engine.
 */
import { existsSync } from 'node:fs';
import type { Plugin } from 'vite';

export interface DashEngineOptions {
  /** client/, with a trailing slash. */
  readonly root: string;
  /** Default `process.env`. Reads VITE_ENGINE_PROBE and VITEST. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Default `existsSync`. */
  readonly exists?: (path: string) => boolean;
}

const ID = 'virtual:dash-engine';
const RESOLVED = `\0${ID}`;

/** The refusal; `<dir>` gen/ or gen-probe/, `<make>` make engine-wasm or make engine-wasm-probe. */
export function engineAbsentMessage(probe: boolean): string {
  const dir = probe ? 'gen-probe/' : 'gen/';
  const make = probe ? 'make engine-wasm-probe' : 'make engine-wasm';
  return `the chart engine is not built (src/engine/wasm/${dir} is missing): run ${make} first`;
}

export function dashEngine(o: DashEngineOptions): Plugin {
  const env = o.env ?? process.env;
  const exists = o.exists ?? existsSync;
  const probe = env['VITE_ENGINE_PROBE'] === '1';
  const testRunner = env['VITEST'] !== undefined;
  const gen = `${o.root}src/engine/wasm/${probe ? 'gen-probe' : 'gen'}/`;
  const absent = `${o.root}src/engine/wasm/absent.ts`;
  const message = engineAbsentMessage(probe);
  // "Engine files": both the glue and its wasm (as plan #68 C1).
  const built = (): boolean =>
    exists(`${gen}dash_core_mt.js`) && exists(`${gen}dash_core_mt_bg.wasm`);
  let command: 'build' | 'serve' = 'serve';
  return {
    name: 'dash-engine',
    configResolved(c) {
      command = c.command;
    },
    buildStart() {
      if (command === 'build' && !testRunner && !built()) this.error(message);
    },
    configureServer() {
      // Before the server listens: `vite` exits non-zero without serving.
      if (!testRunner && !built()) throw new Error(message);
    },
    resolveId(source) {
      return source === ID ? RESOLVED : null;
    },
    load(source) {
      if (source !== RESOLVED) return null;
      if (!built()) {
        if (!testRunner) this.error(message);
        return `export * from '${absent}';
export { default } from '${absent}';`;
      }
      return `export * from '${gen}dash_core_mt.js';
export { default } from '${gen}dash_core_mt.js';
export { default as wasmUrl } from '${gen}dash_core_mt_bg.wasm?url';`;
    },
  };
}
