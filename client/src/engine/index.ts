/**
 * The chart engine the application uses (ADR-0014 §3). The WASM engine is the default (ADR-0031):
 * when the page can run it and no `canvas2d` flag forces Canvas 2D (`select.ts`), a routing engine
 * loads the engine on the first chart frame and keeps Canvas 2D for the kinds it does not draw and
 * for every fallback (`route.ts`, D-ROUTE); otherwise Canvas 2D. A failed boot marks the session
 * (`markOnFailure`, plan #256 §4.2), so later pages start on Canvas 2D. #68 changes only this file
 * of the seam. A fault build opened with `?probe=1` also installs the engine probe
 * (`dev/engineProbe.ts`).
 *
 * Plan #68 C2d2 (§3.3, §4.4): the engine runs in MT or, where the page cannot run the shared-memory
 * engine (or `?mode=st`), in ST. `engineMode()` is the page's engine mode once its first frame
 * booted (or failed to boot) an engine, null before; `onEngineMode` subscribes (the ST banner).
 */
import { createContext } from 'react';
import type { ChartEngine } from './api';
import { Canvas2DEngine } from './canvas2d/Canvas2DEngine';
import { markOnFailure, markSessionFailed, sessionFailed } from './failFlag';
import { RoutingEngine } from './route';
import type { EngineProbe } from './wasm/engine';
import { chooseEngine, probe, stReason, type StReason } from './select';

let engine: ChartEngine | null = null;

/** The page's engine mode (plan #68 C2d2 §3.3). */
export type EngineMode =
  | { readonly mode: 'mt' }
  | { readonly mode: 'st'; readonly reason: StReason }
  | { readonly mode: 'canvas2d' };

let mode: EngineMode | null = null;
const modeListeners = new Set<(m: EngineMode | null) => void>();

function setMode(m: EngineMode): void {
  if (mode !== null && mode.mode === m.mode) return;
  mode = m;
  // After the current task's work (a frame may be created inside a render): the listeners re-read.
  queueMicrotask(() => {
    for (const cb of [...modeListeners]) cb(m);
  });
}

/** The page's engine mode; null before the first frame. */
export function engineMode(): EngineMode | null {
  return mode;
}

/** Calls `cb` on each change of `engineMode()`; returns the unsubscription. */
export function onEngineMode(cb: (m: EngineMode | null) => void): () => void {
  modeListeners.add(cb);
  return () => {
    modeListeners.delete(cb);
  };
}

export function defaultChartEngine(): ChartEngine {
  if (engine !== null) return engine;
  const canvas2d = new Canvas2DEngine();
  const page = probe(sessionFailed());
  const choice = chooseEngine(page);
  if (choice.kind === 'wasm') {
    const booted: EngineMode =
      choice.mode === 'st' ? { mode: 'st', reason: stReason(page) } : { mode: 'mt' };
    const load = (probe?: EngineProbe) =>
      import('./wasm/engine')
        .then((m) =>
          m.loadBackend({
            forceT2: choice.forceT2,
            mode: choice.mode,
            markFailed: () => {
              markSessionFailed();
              setMode({ mode: 'canvas2d' });
            },
            ...(probe === undefined ? {} : { probe }),
          }),
        )
        .then(
          (b) => {
            setMode(booted);
            return b;
          },
          (e: unknown) => {
            setMode({ mode: 'canvas2d' });
            throw e;
          },
        );
    if (
      import.meta.env.VITE_ENGINE_FAULTS === '1' &&
      typeof location !== 'undefined' &&
      new URLSearchParams(location.search).get('probe') === '1'
    ) {
      // Fault builds, `?probe=1`: `__dashProbe` shares the page's engine (plan #68 C2a1 §3.4).
      const search = location.search;
      const probed = import('../dev/engineProbe').then((p) => p.installProbe(load, search));
      engine = new RoutingEngine(
        markOnFailure(() => probed.then((get) => get())),
        canvas2d,
      );
    } else {
      engine = new RoutingEngine(
        markOnFailure(() => load()),
        canvas2d,
      );
    }
  } else if (
    import.meta.env.VITE_ENGINE_FAULTS === '1' &&
    typeof location !== 'undefined' &&
    new URLSearchParams(location.search).has('fault')
  ) {
    // Fault builds: a Canvas 2D page with a fault goes through the routing frames too, so the
    // route site's faults (`empty`) apply to it.
    engine = new RoutingEngine(() => {
      setMode({ mode: 'canvas2d' });
      return Promise.reject(new Error('canvas2d page'));
    }, canvas2d);
  } else {
    // `data-engine` names the engine of every chart canvas (plan #68 C1 §3.4).
    engine = {
      createFrame(canvas, init) {
        setMode({ mode: 'canvas2d' });
        canvas.dataset['engine'] = 'canvas2d';
        return canvas2d.createFrame(canvas, init);
      },
    };
  }
  return engine;
}

export const ChartEngineContext = createContext<ChartEngine>(defaultChartEngine());
