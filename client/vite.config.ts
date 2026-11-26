import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import optimizeLocales from '@react-aria/optimize-locales-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin, type UserConfig } from 'vite';
import { dashEngine } from './config/dashEngine.ts';
import { devHeaders, productionHeaders } from './config/headers.ts';
import { moduleGraphPlugins } from './config/moduleGraph.ts';
import { previewManifest } from './config/previewManifest.ts';

/**
 * Modules of the editor chunk (plan #63 Part C §3.6): `src/editor/` except `lang/index.ts` and
 * `lang/types.ts` (the route imports them), and the 17 packages of `dependency-policy.json`
 * `runtimeClosure.query-editor`. Every chunk holding one is named `editor-*`, so `ci:bundle-size`
 * measures the editor as one closure and `e2e:lazy-load` can name its files.
 */
const EDITOR_MODULE =
  /\/src\/editor\/(?!lang\/(?:index|types)\.ts$)|\/node_modules\/(?:@codemirror|@lezer|@marijn|@prometheus-io|crelt|lru-cache|style-mod|w3c-keyname)\//;

const root = fileURLToPath(new URL('.', import.meta.url));

// `dash-module-ids` (plan #198 Part 2a §3.6): each build's module graph, workers included.
const moduleIds = moduleGraphPlugins(`${root}node_modules/.cache/dash-build`);

/** Engine modules: their chunks are `dash-engine-*` (`ci:bundle-size` engine row). */
const ENGINE_MODULE = /\/src\/engine\/wasm\/|dash-engine/;
const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as { version: string };

// The BFF the dev server proxies to (ADR-0014 §6). Never logged.
const bff = process.env['PULSUS_DASH_DEV_BFF'] ?? 'http://localhost:8080';

/**
 * The client's Vite configuration with `engine` as the `virtual:dash-engine` plugin. `vite build`,
 * the dev server and `vite preview` use `dashEngine` (this file's default export): without the
 * engine they refuse to run, whatever the environment (plan #256 §3.3, ADR-0031). Only
 * `vitest.config.ts` passes `absentEngine`, so the unit tests, which never load the engine, run
 * without it.
 */
export function clientConfig(engine: (root: string) => Plugin): UserConfig {
  return {
    plugins: [
      react(),
      optimizeLocales.vite({ locales: ['en-US'] }),
      // `virtual:dash-engine`: the engine's glue; without it `vite build` and the dev server refuse
      // to run (plan #256 §3.3, ADR-0031).
      engine(root),
      moduleIds.main,
      // `vite preview` only: the computed `/asset-manifest.json`, loopback only (plan #256 §3.5).
      previewManifest(),
    ],
    resolve: {
      // `findIframes` (plan #198 Part 2a §3.3): `parse5-sax-parser`'s tokenizer driver without its
      // `SAXParser` entry, which extends `node:stream` (pinned at 8.0.1; applies to vitest too).
      alias: [
        {
          find: /^parse5-sax-parser\/feedback$/,
          replacement: `${root}node_modules/parse5-sax-parser/dist/parser-feedback-simulator.js`,
        },
      ],
    },
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    build: {
      assetsInlineLimit: 0,
      manifest: true,
      modulePreload: { polyfill: false },
      rolldownOptions: {
        // `geo-assets` (plan #231 §3.2): `src/vis/geo/urls.ts` imports the geo assets with `?url`, so
        // the build content-hashes and emits them, and the signed manifest lists them, before any
        // route imports the geo modules (T24-087).
        input: { index: `${root}index.html`, 'geo-assets': `${root}src/vis/geo/urls.ts` },
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
      plugins: () => [engine(root), moduleIds.worker()],
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
  };
}

export default defineConfig(clientConfig((r) => dashEngine({ root: r })));
