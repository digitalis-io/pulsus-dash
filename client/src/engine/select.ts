/**
 * Engine selection (plan #68 C1 §3.5, D-SEL): the WASM engine is opt-in until #69 draws axes and
 * the other kinds. The flag is the URL's `engine` parameter, else the build's `VITE_ENGINE`, else
 * `canvas2d`. Even when it says `wasm`, the engine runs only cross-origin isolated, with
 * OffscreenCanvas, a GPU API and `Atomics.waitAsync` (the CSP blocks the glue's blob-worker
 * fallback), outside the modes it does not serve yet (`st`, `mtr`, `static`: Canvas 2D until
 * `dash-core-st`), and not after it failed earlier in this session (T03-025).
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

export type EngineChoice = { kind: 'canvas2d' } | { kind: 'wasm'; forceT2: boolean };

/** Modes the engine does not run in yet (T03 §9.2). */
const CANVAS_MODES = new Set(['st', 'mtr', 'static']);

export function chooseEngine(p: Probe): EngineChoice {
  const q = new URLSearchParams(p.search);
  const flag = q.get('engine') ?? p.buildFlag ?? 'canvas2d';
  const mode = q.get('mode');
  if (flag !== 'wasm' || p.failedThisSession) return { kind: 'canvas2d' };
  if (mode !== null && CANVAS_MODES.has(mode)) return { kind: 'canvas2d' };
  if (!p.isolated || !p.offscreen || (!p.webgpu && !p.webgl2) || !p.waitAsync) {
    return { kind: 'canvas2d' };
  }
  return { kind: 'wasm', forceT2: mode === 't2' };
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
