/**
 * The unit tests' configuration (Vitest reads this file in place of `vite.config.ts`; `vite build`,
 * the dev server and `vite preview` never read it). It is the client's configuration with
 * `absentEngine` as the `virtual:dash-engine` plugin: the unit tests never load the engine, so they
 * run without `src/engine/wasm/gen/` (plan #256 §3.3). This file is the only place that
 * substitution exists; every build and dev server keeps `dashEngine`, which refuses to run without
 * the engine (ADR-0031).
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { absentEngine } from './config/dashEngine.ts';
import { clientConfig } from './vite.config.ts';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  ...clientConfig(absentEngine),
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
