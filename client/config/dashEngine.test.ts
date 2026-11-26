/**
 * The `dash-engine` plugin (plan #256 §3.3, ADR-0031): the engine's glue when it is built, a refusal
 * from `vite build` and the dev server when it is not, and `absent.ts` for the test runner only.
 * `ci:engine-built` runs a real dev server and a real build on a fixture without the engine.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer as netServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, createServer, type Plugin } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import { dashEngine, engineAbsentMessage } from './dashEngine.ts';

const ROOT = '/r/client/';
const ID = '\0virtual:dash-engine';
const GEN =
  'the chart engine is not built (src/engine/wasm/gen/ is missing): run make engine-wasm first';
const PROBE =
  'the chart engine is not built (src/engine/wasm/gen-probe/ is missing): run make engine-wasm-probe first';

type Fn = (this: unknown, ...a: unknown[]) => unknown;

/** A plugin hook as a function (a hook may be an object with a `handler`). */
function hook(p: Plugin, name: keyof Plugin): Fn {
  const h = p[name] as unknown;
  const fn =
    typeof h === 'function'
      ? h
      : typeof h === 'object' && h !== null && 'handler' in h
        ? h.handler
        : undefined;
  expect(typeof fn, `${name} hook`).toBe('function');
  return fn as Fn;
}

/** `this.error` of Rollup's plugin context: it throws. */
const ctx = {
  error(m: unknown): never {
    throw new Error(String(m));
  },
};

function plugin(
  command: 'build' | 'serve',
  exists: boolean,
  env: Record<string, string | undefined>,
): Plugin {
  const p = dashEngine({ root: ROOT, env, exists: () => exists });
  hook(p, 'configResolved').call(ctx, { command });
  return p;
}

const fixtures: string[] = [];
afterEach(() => {
  for (const d of fixtures.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A client root without the engine, under `node_modules/.cache/`. */
function fixture(files: Record<string, string>): string {
  const cache = fileURLToPath(new URL('../node_modules/.cache/', import.meta.url));
  mkdirSync(cache, { recursive: true });
  const d = mkdtempSync(join(cache, 'dash-engine-'));
  fixtures.push(d);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(d, name), text);
  return d;
}

/** A port nothing listens on (taken and released). */
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

/** Whether a TCP connection to localhost:port succeeds. */
function listening(port: number): Promise<boolean> {
  return new Promise((r) => {
    const c = createConnection({ port, host: 'localhost' });
    c.once('connect', () => {
      c.destroy();
      r(true);
    });
    c.once('error', () => {
      r(false);
    });
  });
}

describe('dash-engine plugin (plan #256 §3.3)', () => {
  it('present: the glue of gen/ and the wasm URL', async () => {
    const p = plugin('build', true, {});
    expect(hook(p, 'resolveId').call(ctx, 'virtual:dash-engine')).toBe(ID);
    const src = String(await hook(p, 'load').call(ctx, ID));
    expect(src).toContain(`export * from '${ROOT}src/engine/wasm/gen/dash_core_mt.js';`);
    expect(src).toContain(`export { default } from '${ROOT}src/engine/wasm/gen/dash_core_mt.js';`);
    expect(src).toContain(
      `export { default as wasmUrl } from '${ROOT}src/engine/wasm/gen/dash_core_mt_bg.wasm?url';`,
    );
    expect(src).not.toContain('absent.ts');
  });

  it('absent: vite build and the dev server refuse, naming the make target', () => {
    const b = plugin('build', false, {});
    expect(() => hook(b, 'buildStart').call(ctx)).toThrow(GEN);
    const s = plugin('serve', false, {});
    expect(() => hook(s, 'configureServer').call(ctx, {})).toThrow(GEN);

    const probe = plugin('build', false, { VITE_ENGINE_PROBE: '1' });
    expect(() => hook(probe, 'buildStart').call(ctx)).toThrow(PROBE);
    // A renderer override is not an opt-out: the build still needs the engine.
    const pinned = plugin('build', false, { VITE_ENGINE: 'canvas2d' });
    expect(() => hook(pinned, 'buildStart').call(ctx)).toThrow(GEN);
    expect(engineAbsentMessage(false)).toBe(GEN);
    expect(engineAbsentMessage(true)).toBe(PROBE);
  });

  it('the test runner: absent.ts, no refusal', async () => {
    const p = plugin('serve', false, { VITEST: 'true' });
    expect(() => hook(p, 'configureServer').call(ctx, {})).not.toThrow();
    expect(() => hook(p, 'buildStart').call(ctx)).not.toThrow();
    const src = String(await hook(p, 'load').call(ctx, ID));
    expect(src).toContain(`export * from '${ROOT}src/engine/wasm/absent.ts';`);
    expect(src).toContain(`export { default } from '${ROOT}src/engine/wasm/absent.ts';`);
  });
});

describe('ci:engine-built (plan #256 §3.3, Acceptance 3)', () => {
  it('a dev server without the engine refuses to start; nothing listens', async () => {
    const root = fixture({ 'index.html': '<!doctype html><title>x</title>' });
    const port = await freePort();
    const start = createServer({
      configFile: false,
      root,
      logLevel: 'silent',
      server: { port, strictPort: true },
      plugins: [dashEngine({ root: `${root}/`, env: {} })],
    }).then(async (s) => {
      // `vite` listens after creating the server; close it again if it got that far.
      await s.listen();
      await s.close();
      return 'served';
    });
    await expect(start).rejects.toThrow(GEN);
    expect(await listening(port)).toBe(false);
  });

  it('vite build without the engine fails', async () => {
    const root = fixture({
      'index.html': '<!doctype html><title>x</title><script type="module" src="/main.js"></script>',
      'main.js': "import engine from 'virtual:dash-engine';\nconsole.log(engine);\n",
    });
    const run = build({
      configFile: false,
      root,
      logLevel: 'silent',
      build: { write: false },
      plugins: [dashEngine({ root: `${root}/`, env: {} })],
    });
    await expect(run).rejects.toThrow(GEN);
  });
});
