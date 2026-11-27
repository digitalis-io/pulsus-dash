/**
 * `virtual:dash-engine` (plan #68 C1 §2; plan #256 §3.3, ADR-0031): the wasm-bindgen glue of
 * `cargo xtask build-wasm` in the git-ignored `src/engine/wasm/gen/` with the URL of its wasm;
 * `virtual:dash-engine-st` (plan #68 C2d2) the single-thread engine's of `gen-st/`. With
 * `VITE_ENGINE_PROBE=1` (the probe build of `e2e:shim-fuzz`, plan #68 C2a1 §3.5) it is the `--probe`
 * engine in `src/engine/wasm/gen-probe/` instead. Types: `src/engine/wasm/engine-module.d.ts`.
 *
 * The engine is the default renderer, so every build and dev server includes it: without the two
 * files of either engine `vite build` fails at `buildStart` and the dev server refuses to start, naming the `make`
 * target that builds it, whatever the environment. `VITE_ENGINE=canvas2d` is a renderer override,
 * not an opt-out. The unit tests never load the engine: `vitest.config.ts`, which only Vitest
 * reads, uses `absentEngine` (`src/engine/wasm/absent.ts`) in place of this plugin.
 */
import { existsSync } from 'node:fs';
import type { Plugin } from 'vite';

export interface DashEngineOptions {
  /** client/, with a trailing slash. */
  readonly root: string;
  /** Default `process.env`. Reads VITE_ENGINE_PROBE. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Default `existsSync`. */
  readonly exists?: (path: string) => boolean;
}

const ID = 'virtual:dash-engine';
const RESOLVED = `\0${ID}`;
/** Plan #68 C2d2: the single-thread engine (`dash-core-st`) of `gen-st/` (`gen-st-probe/`). */
const ST_ID = 'virtual:dash-engine-st';
const ST_RESOLVED = `\0${ST_ID}`;

/**
 * The refusal; `<dir>` gen/, gen-probe/, gen-st/ or gen-st-probe/, `<make>` make engine-wasm or make
 * engine-wasm-probe (each builds both engines).
 */
export function engineAbsentMessage(probe: boolean, st = false): string {
  const dir = `${st ? 'gen-st' : 'gen'}${probe ? '-probe' : ''}/`;
  const make = probe ? 'make engine-wasm-probe' : 'make engine-wasm';
  return `the chart engine is not built (src/engine/wasm/${dir} is missing): run ${make} first`;
}

export function dashEngine(o: DashEngineOptions): Plugin {
  const env = o.env ?? process.env;
  const exists = o.exists ?? existsSync;
  const probe = env['VITE_ENGINE_PROBE'] === '1';
  const suffix = probe ? '-probe' : '';
  const gen = `${o.root}src/engine/wasm/gen${suffix}/`;
  const genSt = `${o.root}src/engine/wasm/gen-st${suffix}/`;
  // "Engine files": the glue and its wasm, of each engine (as plan #68 C1, C2d2).
  const builtMt = (): boolean =>
    exists(`${gen}dash_core_mt.js`) && exists(`${gen}dash_core_mt_bg.wasm`);
  const builtSt = (): boolean =>
    exists(`${genSt}dash_core_st.js`) && exists(`${genSt}dash_core_st_bg.wasm`);
  /** The refusal for the first engine that is missing, or null. */
  const missing = (): string | null =>
    !builtMt() ? engineAbsentMessage(probe) : !builtSt() ? engineAbsentMessage(probe, true) : null;
  let command: 'build' | 'serve' = 'serve';
  return {
    name: 'dash-engine',
    configResolved(c) {
      command = c.command;
    },
    buildStart() {
      const m = command === 'build' ? missing() : null;
      if (m !== null) this.error(m);
    },
    configureServer() {
      // Before the server listens: `vite` exits non-zero without serving.
      const m = missing();
      if (m !== null) throw new Error(m);
    },
    resolveId(source) {
      return source === ID ? RESOLVED : source === ST_ID ? ST_RESOLVED : null;
    },
    load(source) {
      if (source !== RESOLVED && source !== ST_RESOLVED) return null;
      const m = missing();
      if (m !== null) this.error(m);
      const [dir, name] = source === RESOLVED ? [gen, 'dash_core_mt'] : [genSt, 'dash_core_st'];
      return `export * from '${dir}${name}.js';
export { default } from '${dir}${name}.js';
export { default as wasmUrl } from '${dir}${name}_bg.wasm?url';`;
    },
  };
}

/**
 * `virtual:dash-engine` and `virtual:dash-engine-st` as `src/engine/wasm/absent.ts`, for the unit
 * tests only: `vitest.config.ts` is its one user. It has no build or server hook, so it cannot stand
 * in for `dashEngine` anywhere else.
 */
export function absentEngine(root: string): Plugin {
  const absent = `${root}src/engine/wasm/absent.ts`;
  return {
    name: 'dash-engine-absent',
    resolveId(source) {
      return source === ID ? RESOLVED : source === ST_ID ? ST_RESOLVED : null;
    },
    load(source) {
      if (source !== RESOLVED && source !== ST_RESOLVED) return null;
      return `export * from '${absent}';
export { default } from '${absent}';`;
    },
  };
}
