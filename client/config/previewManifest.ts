/**
 * The preview's asset manifest (plan #256 §3.5, ADR-0031). The engine fetches its wasm with the
 * SHA-384 that `/asset-manifest.json` lists for it, and a release build without a manifest treats
 * the engine as unavailable (`src/engine/wasm/integrity.ts`). The BFF serves the manifest it
 * verified against its signature (ADR-0016); `vite preview` has none, so this plugin computes one
 * from the build it serves, once, when the preview server starts. The browser still checks every
 * byte of the wasm against it, so a changed byte is refused, as behind the BFF.
 *
 * The manifest is computed by the server it describes, so it proves transit integrity only: the
 * preview listens on this machine only, and refuses any other host. The BFF's signed manifest is the
 * only deployment path. No signature is served: the browser never reads it. The dev server serves
 * no manifest (it fetches the wasm plainly).
 */
import { isIPv4 } from 'node:net';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';
import { manifestEntries } from '../scripts/pack-assets.ts';
import { productionHeaders } from './headers.ts';

const PATH = '/asset-manifest.json';

/** `undefined`/`false` (Vite's default: localhost), `localhost`, `::1`, or IPv4 in 127.0.0.0/8. */
export function isLoopbackHost(host: string | boolean | undefined): boolean {
  if (host === undefined || host === false) return true;
  if (host === true) return false;
  if (host === 'localhost' || host === '::1') return true;
  return isIPv4(host) && host.split('.')[0] === '127';
}

/** `vite preview` only: GET/HEAD `/asset-manifest.json` → `{"version":1,"files":[…]}`. */
export function previewManifest(): Plugin {
  return {
    name: 'preview-manifest',
    configurePreviewServer(server) {
      const host = server.config.preview.host;
      if (!isLoopbackHost(host)) {
        throw new Error(
          `the preview server computes its own asset manifest and is for this machine only: it was asked to listen on ${String(host)}; serve the client through the BFF (make build) instead`,
        );
      }
      const dist = resolve(server.config.root, server.config.build.outDir);
      const body = Buffer.from(
        `${JSON.stringify({ version: 1, files: manifestEntries(dist) }, null, 2)}\n`,
      );
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0];
        if (path !== PATH || (req.method !== 'GET' && req.method !== 'HEAD')) {
          next();
          return;
        }
        for (const [k, v] of Object.entries(productionHeaders)) res.setHeader(k, v);
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Length', String(body.length));
        res.statusCode = 200;
        res.end(req.method === 'HEAD' ? undefined : body);
      });
    },
  };
}
