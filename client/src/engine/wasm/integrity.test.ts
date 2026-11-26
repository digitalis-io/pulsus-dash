import { describe, expect, it, vi } from 'vitest';
import { fetchEngineWasm } from './integrity';

const WASM = '/assets/dash-engine-a.wasm';
const MANIFEST = { files: [{ path: 'assets/dash-engine-a.wasm', sha384: 'Zm9v', size: 3 }] };

type Outcome = 'ok' | 'reject';

/** A fetch whose manifest answers `manifest` and whose wasm requests follow `wasm` in turn. */
function fakeFetch(manifest: 'ok' | 404, wasm: Outcome[]) {
  const wasmCalls: (RequestInit | undefined)[] = [];
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/asset-manifest.json')) {
      return Promise.resolve(
        manifest === 'ok'
          ? new Response(JSON.stringify(MANIFEST), { status: 200 })
          : new Response('{}', { status: 404 }),
      );
    }
    wasmCalls.push(init);
    const o = wasm[wasmCalls.length - 1] ?? 'reject';
    return o === 'ok'
      ? Promise.resolve(new Response(new Uint8Array([0, 97, 115, 109]), { status: 200 }))
      : Promise.reject(new TypeError('integrity mismatch'));
  });
  return { fn: fn as unknown as typeof fetch, wasmCalls };
}

describe('engine wasm integrity (T18-006)', () => {
  it.each<[string, Outcome[], number, boolean]>([
    ['first fetch ok', ['ok'], 1, true],
    ['one retry', ['reject', 'ok'], 2, true],
    ['two failures', ['reject', 'reject'], 2, false],
  ])('%s', async (_name, wasm, calls, ok) => {
    const f = fakeFetch('ok', wasm);
    const r = await fetchEngineWasm(WASM, { fetch: f.fn, dev: false });
    expect(f.wasmCalls).toHaveLength(calls);
    for (const init of f.wasmCalls) expect(init).toEqual({ integrity: 'sha384-Zm9v' });
    expect(r.ok).toBe(ok);
    if (!r.ok) expect(r.reason).toBe('engine_integrity_failed');
  });

  it('no manifest: unavailable in a release build, a plain fetch in dev', async () => {
    const release = fakeFetch(404, ['ok']);
    const r = await fetchEngineWasm(WASM, { fetch: release.fn, dev: false });
    expect(r).toEqual({ ok: false, reason: 'engine_integrity_failed' });
    expect(release.wasmCalls).toHaveLength(0);
    const dev = fakeFetch(404, ['ok']);
    const d = await fetchEngineWasm(WASM, { fetch: dev.fn, dev: true });
    expect(d.ok).toBe(true);
    expect(dev.wasmCalls).toEqual([undefined]);
  });

  it('a wasm file the manifest does not list is unavailable', async () => {
    const f = fakeFetch('ok', ['ok']);
    const r = await fetchEngineWasm('/assets/dash-engine-b.wasm', { fetch: f.fn, dev: false });
    expect(r.ok).toBe(false);
    expect(f.wasmCalls).toHaveLength(0);
  });
});
