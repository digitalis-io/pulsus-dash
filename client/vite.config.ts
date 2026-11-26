/// <reference types="vitest/config" />
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import optimizeLocales from '@react-aria/optimize-locales-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { devHeaders, productionHeaders } from './config/headers.ts';

/**
 * Modules of the editor chunk (plan #63 Part C §3.6): `src/editor/` except `lang/index.ts` and
 * `lang/types.ts` (the route imports them), and the 17 packages of `dependency-policy.json`
 * `runtimeClosure.query-editor`. Every chunk holding one is named `editor-*`, so `ci:bundle-size`
 * measures the editor as one closure and `e2e:lazy-load` can name its files.
 */
const EDITOR_MODULE =
  /\/src\/editor\/(?!lang\/(?:index|types)\.ts$)|\/node_modules\/(?:@codemirror|@lezer|@marijn|@prometheus-io|crelt|lru-cache|style-mod|w3c-keyname)\//;

const root = fileURLToPath(new URL('.', import.meta.url));

/**
 * `virtual:dash-engine` (plan #68 C1 §2): the wasm-bindgen glue of `cargo xtask build-wasm` in the
 * git-ignored `src/engine/wasm/gen/` with the URL of its wasm, or `src/engine/wasm/absent.ts` in a
 * build without the engine (every frame stays on Canvas 2D). Types: `wasm/engine-module.d.ts`.
 * With `VITE_ENGINE_PROBE=1` (the probe build of `e2e:shim-fuzz`, plan #68 C2a1 §3.5) it is the
 * `--probe` engine in `src/engine/wasm/gen-probe/` instead.
 */
function dashEngine(): Plugin {
  const id = 'virtual:dash-engine';
  const resolved = `\0${id}`;
  const probe = process.env['VITE_ENGINE_PROBE'] === '1';
  const gen = `${root}src/engine/wasm/${probe ? 'gen-probe' : 'gen'}/`;
  return {
    name: 'dash-engine',
    resolveId(source) {
      return source === id ? resolved : null;
    },
    load(source) {
      if (source !== resolved) return null;
      if (!existsSync(`${gen}dash_core_mt.js`) || !existsSync(`${gen}dash_core_mt_bg.wasm`)) {
        return `export * from '${root}src/engine/wasm/absent.ts';
export { default } from '${root}src/engine/wasm/absent.ts';`;
      }
      return `export * from '${gen}dash_core_mt.js';
export { default } from '${gen}dash_core_mt.js';
export { default as wasmUrl } from '${gen}dash_core_mt_bg.wasm?url';`;
    },
  };
}

/** Engine modules: their chunks are `dash-engine-*` (`ci:bundle-size` engine row). */
const ENGINE_MODULE = /\/src\/engine\/wasm\/|dash-engine/;
const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as { version: string };

// The BFF the dev server proxies to (ADR-0014 §6). Never logged.
const bff = process.env['PULSUS_DASH_DEV_BFF'] ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [react(), optimizeLocales.vite({ locales: ['en-US'] }), dashEngine()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    assetsInlineLimit: 0,
    manifest: true,
    modulePreload: { polyfill: false },
    rolldownOptions: {
      output: {
        chunkFileNames: (c) =>
          c.moduleIds.some((id) => EDITOR_MODULE.test(id))
            ? 'assets/editor-[hash].js'
            : c.moduleIds.some((id) => ENGINE_MODULE.test(id))
              ? 'assets/dash-engine-[hash].js'
              : 'assets/[name]-[hash].js',
        assetFileNames: (a) =>
          a.names.some((n) => n.endsWith('.wasm'))
            ? 'assets/dash-engine-[hash][extname]'
            : 'assets/[name]-[hash][extname]',
      },
    },
  },
  // The engine's workers (plan #68 C1 §3.5): ES modules named `dash-engine-[name]-[hash].js`.
  worker: {
    format: 'es',
    plugins: () => [dashEngine()],
    rolldownOptions: {
      output: {
        entryFileNames: 'assets/dash-engine-[name]-[hash].js',
        chunkFileNames: 'assets/dash-engine-[hash].js',
        assetFileNames: 'assets/dash-engine-[hash][extname]',
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    headers: devHeaders,
    proxy: { '/api': bff, '/auth': bff },
    // The tests import the shared wire fixtures (plan #62: golden frames, step cases) with ?raw.
    fs: { allow: [root, `${root}../wire`] },
  },
  preview: {
    port: 4173,
    strictPort: true,
    headers: { ...productionHeaders },
  },
  test: {
    // The PromQL language package has no `exports` map, so the test runner would load its
    // CommonJS `main` with a second copy of @codemirror/state. The tests use its `module` (ESM)
    // build, as the browser build does, and inline it so Vite transforms it (plan #63 Part B).
    alias: {
      '@prometheus-io/codemirror-promql': `${root}node_modules/@prometheus-io/codemirror-promql/dist/esm/index.js`,
    },
    server: { deps: { inline: [/@prometheus-io\/codemirror-promql/] } },
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['scripts/**/*.test.ts', 'config/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: ['src/**/*.test.{ts,tsx}'],
          setupFiles: ['src/test/setup.ts'],
          testTimeout: 20_000,
        },
      },
    ],
  },
});
