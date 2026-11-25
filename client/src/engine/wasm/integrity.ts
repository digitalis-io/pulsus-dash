/**
 * The engine wasm's integrity (plan #68 C1 §4.1, T18-006, ADR-0016): the wasm is fetched with the
 * SHA-384 the BFF-verified `/asset-manifest.json` lists for it, so the browser refuses a changed
 * byte; one retry. Without a manifest a dev server fetches it plainly; a release build treats
 * the engine as unavailable (`engine_integrity_failed`), as it does a file the manifest does not
 * list.
 */
export type WasmFetch =
  | { readonly ok: true; readonly response: Response }
  | { readonly ok: false; readonly reason: 'engine_integrity_failed' };

export interface FetchOptions {
  readonly fetch: typeof fetch;
  /** `import.meta.env.DEV`. */
  readonly dev: boolean;
}

const UNAVAILABLE: WasmFetch = { ok: false, reason: 'engine_integrity_failed' };

interface ManifestFile {
  readonly path: string;
  readonly sha384: string;
}

/** The manifest's files, or null when there is none (or it does not parse). */
async function manifestFiles(f: typeof fetch): Promise<ManifestFile[] | null> {
  try {
    const r = await f('/asset-manifest.json');
    if (!r.ok) return null;
    const m = (await r.json()) as { files?: unknown };
    if (!Array.isArray(m.files)) return null;
    return m.files.filter(
      (x): x is ManifestFile =>
        typeof x === 'object' &&
        x !== null &&
        typeof (x as ManifestFile).path === 'string' &&
        typeof (x as ManifestFile).sha384 === 'string',
    );
  } catch {
    return null;
  }
}

/** The manifest path of a URL on this origin: `/assets/x.wasm` → `assets/x.wasm`. */
function pathOf(url: string): string {
  const base = typeof location === 'undefined' ? 'http://localhost/' : location.href;
  return new URL(url, base).pathname.replace(/^\//, '');
}

export async function fetchEngineWasm(url: string, o: FetchOptions): Promise<WasmFetch> {
  const files = await manifestFiles(o.fetch);
  if (files === null) {
    if (!o.dev) return UNAVAILABLE;
    try {
      return { ok: true, response: await o.fetch(url) };
    } catch {
      return UNAVAILABLE;
    }
  }
  const entry = files.find((f) => f.path === pathOf(url));
  if (entry === undefined) return UNAVAILABLE;
  const integrity = `sha384-${entry.sha384}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await o.fetch(url, { integrity });
      if (response.ok) return { ok: true, response };
    } catch {
      // An integrity mismatch rejects: try once more, then give up.
    }
  }
  return UNAVAILABLE;
}
