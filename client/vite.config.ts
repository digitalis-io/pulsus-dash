/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import optimizeLocales from '@react-aria/optimize-locales-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { devHeaders, productionHeaders } from './config/headers.ts';

const root = fileURLToPath(new URL('.', import.meta.url));
const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as { version: string };

// The BFF the dev server proxies to (ADR-0014 §6). Never logged.
const bff = process.env['PULSUS_DASH_DEV_BFF'] ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [react(), optimizeLocales.vite({ locales: ['en-US'] })],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    assetsInlineLimit: 0,
    manifest: true,
    modulePreload: { polyfill: false },
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
