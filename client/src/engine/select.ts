/**
 * Engine selection (plan #68 C1 §3.5; plan #256 §3.1; plan #68 C2d2 §3.3): the WASM engine is the
 * default renderer and Canvas 2D the fallback (ADR-0031). Only the flag `canvas2d` forces Canvas
 * 2D: the URL's `engine` parameter, else the build's `VITE_ENGINE`; any other value, or none,
 * selects the engine. It needs OffscreenCanvas and a GPU API. Cross-origin isolated with
 * `Atomics.waitAsync` it is the shared-memory engine (`mt`); without either, or with `?mode=st`, the
 * single-thread engine (`st`, T03 §9.2). The modes it does not serve yet (`mtr`, `static`: #269,
 * #270) and a failure earlier in this session (T03-025), a failed boot included (`failFlag.ts`
 * `markOnFailure`), are Canvas 2D.
 */
export interface Probe {
  /** `location.search`. */
  readonly search: string;
  /** `import.meta.env.VITE_ENGINE`. */
  readonly buildFlag: string | undefined;
  readonly isolated: boolean;
  readonly offscreen: boolean;
  readonly webgpu: boolean;
  readonly webgl2: boolean;
  readonly waitAsync: boolean;
  /** `sessionFailed()` (failFlag.ts). */
  readonly failedThisSession: boolean;
}

export type EngineChoice =
  { kind: 'canvas2d' } | { kind: 'wasm'; forceT2: boolean; mode: 'mt' | 'st' };

/** Why the single-thread engine runs (plan #68 C2d2 §4.4): the banner's reason. */
export type StReason = 'isolation' | 'waitAsync' | 'forced';

/** Modes the engine does not run in yet (T03 §9.2: MT-R #269, Static #270). */
const CANVAS_MODES = new Set(['mtr', 'static']);

export function chooseEngine(p: Probe): EngineChoice {
  const q = new URLSearchParams(p.search);
  // The URL's `engine` beats the build's; only `canvas2d` forces Canvas 2D (ADR-0031).
  const flag = q.get('engine') ?? p.buildFlag;
  const mode = q.get('mode');
  if (flag === 'canvas2d' || p.failedThisSession) return { kind: 'canvas2d' };
  if (mode !== null && CANVAS_MODES.has(mode)) return { kind: 'canvas2d' };
  if (!p.offscreen || (!p.webgpu && !p.webgl2)) return { kind: 'canvas2d' };
  if (mode === 'st' || !p.isolated || !p.waitAsync) {
    return { kind: 'wasm', forceT2: false, mode: 'st' };
  }
  return { kind: 'wasm', forceT2: mode === 't2', mode: 'mt' };
}

/** The ST engine's reason, first match: `?mode=st`, not isolated, no `Atomics.waitAsync`. */
export function stReason(p: Probe): StReason {
  if (new URLSearchParams(p.search).get('mode') === 'st') return 'forced';
  if (!p.isolated) return 'isolation';
  return 'waitAsync';
}

/** The capability bits of T03 §9.1, from this page. */
export function probe(failedThisSession: boolean): Probe {
  const g = globalThis as typeof globalThis & { crossOriginIsolated?: boolean };
  return {
    search: typeof location === 'undefined' ? '' : location.search,
    buildFlag: import.meta.env.VITE_ENGINE,
    isolated: (g.crossOriginIsolated ?? false) && typeof SharedArrayBuffer === 'function',
    offscreen:
      typeof HTMLCanvasElement !== 'undefined' &&
      'transferControlToOffscreen' in HTMLCanvasElement.prototype,
    webgpu: typeof navigator !== 'undefined' && 'gpu' in navigator,
    webgl2: typeof WebGL2RenderingContext !== 'undefined',
    waitAsync: typeof (Atomics as { waitAsync?: unknown }).waitAsync === 'function',
    failedThisSession,
  };
}
