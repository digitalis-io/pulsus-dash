/**
 * The preview's computed asset manifest (plan #256 §3.5): `vite preview` serves
 * `/asset-manifest.json` for its `dist/`, so the engine's integrity check runs there, and it
 * refuses to listen anywhere but on this machine.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer as netServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preview, type PreviewServer } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import { isLoopbackHost, previewManifest } from './previewManifest.ts';

const dirs: string[] = [];
const servers: PreviewServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const FILES: Record<string, string> = {
  'index.html': '<!doctype html><title>x</title>',
  'assets/a.js': 'export const a = 1;\n',
  'assets/dash-engine-x.wasm': '\0asm\x01\0\0\0',
  '.vite/manifest.json': '{}',
};

/** A client root with a built `dist/`, under `node_modules/.cache/`. */
function fixture(): string {
  const cache = fileURLToPath(new URL('../node_modules/.cache/', import.meta.url));
  mkdirSync(cache, { recursive: true });
  const root = mkdtempSync(join(cache, 'preview-manifest-'));
  dirs.push(root);
  for (const [name, text] of Object.entries(FILES)) {
    const p = join(root, 'dist', ...name.split('/'));
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, text);
  }
  return root;
}

async function freePort(): Promise<number> {
  const s = netServer();
  await new Promise<void>((r) => {
    s.listen(0, '127.0.0.1', r);
  });
  const a = s.address();
  await new Promise<void>((r) => {
    s.close(() => {
      r();
    });
  });
  if (a === null || typeof a === 'string') throw new Error('no port');
  return a.port;
}

function listening(port: number): Promise<boolean> {
  return new Promise((r) => {
    const c = createConnection({ port, host: '127.0.0.1' });
    c.once('connect', () => {
      c.destroy();
      r(true);
    });
    c.once('error', () => {
      r(false);
    });
  });
}

async function start(root: string, port: number, host?: string | boolean): Promise<PreviewServer> {
  const s = await preview({
    configFile: false,
    root,
    logLevel: 'silent',
    preview: { port, strictPort: true, ...(host === undefined ? {} : { host }) },
    plugins: [previewManifest()],
  });
  servers.push(s);
  return s;
}

const sha = (text: string): string => createHash('sha384').update(text).digest('base64');

const refusal = (host: string): string =>
  `the preview server computes its own asset manifest and is for this machine only: it was asked to listen on ${host}; serve the client through the BFF (make build) instead`;

describe('previewManifest (plan #256 §3.5)', () => {
  it("serves the dist's manifest: sorted, SHA-384, no .vite/, the production headers", async () => {
    const port = await freePort();
    await start(fixture(), port);
    const r = await fetch(`http://127.0.0.1:${String(port)}/asset-manifest.json`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/json');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(r.headers.get('content-security-policy')).toContain("default-src 'none'");
    const body = (await r.json()) as { version?: number; files?: unknown };
    expect(body.version).toBe(1);
    expect(body.files).toEqual(
      ['assets/a.js', 'assets/dash-engine-x.wasm', 'index.html'].map((path) => {
        const text = FILES[path] ?? '';
        return { path, sha384: sha(text), size: Buffer.byteLength(text) };
      }),
    );
    const head = await fetch(`http://127.0.0.1:${String(port)}/asset-manifest.json`, {
      method: 'HEAD',
    });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-type')).toBe('application/json');
    // Other paths pass through to the preview's own files.
    const js = await fetch(`http://127.0.0.1:${String(port)}/assets/a.js`);
    expect(await js.text()).toBe(FILES['assets/a.js']);
  });

  it('refuses any host but this machine; localhost starts', async () => {
    for (const host of ['0.0.0.0', true] as const) {
      const port = await freePort();
      await expect(start(fixture(), port, host)).rejects.toThrow(refusal(String(host)));
      expect(await listening(port), String(host)).toBe(false);
    }
    const port = await freePort();
    await start(fixture(), port, 'localhost');
    const r = await fetch(`http://localhost:${String(port)}/asset-manifest.json`);
    expect(r.status).toBe(200);
    expect(((await r.json()) as { version?: number }).version).toBe(1);
  });

  it.each<[string | boolean | undefined, boolean]>([
    [undefined, true],
    [false, true],
    ['localhost', true],
    ['::1', true],
    ['127.0.0.1', true],
    ['127.0.0.2', true],
    ['127.255.255.254', true],
    ['::', false],
    ['0.0.0.0', false],
    ['10.0.0.1', false],
    ['128.0.0.1', false],
    ['127.0.0.256', false],
    ['example.test', false],
    [true, false],
  ])('isLoopbackHost(%s) is %s', (host, want) => {
    expect(isLoopbackHost(host)).toBe(want);
  });
});
