/**
 * The chart engine the application uses (ADR-0014 §3). The WASM engine is the default (ADR-0031):
 * when the page can run it and no `canvas2d` flag forces Canvas 2D (`select.ts`), a routing engine
 * loads the engine on the first chart frame and keeps Canvas 2D for the kinds it does not draw and
 * for every fallback (`route.ts`, D-ROUTE); otherwise Canvas 2D. A failed boot marks the session
 * (`markOnFailure`, plan #256 §4.2), so later pages start on Canvas 2D. #68 changes only this file
 * of the seam. A fault build opened with `?probe=1` also installs the engine probe
 * (`dev/engineProbe.ts`).
 */
import { createContext } from 'react';
import type { ChartEngine } from './api';
import { Canvas2DEngine } from './canvas2d/Canvas2DEngine';
import { markOnFailure, markSessionFailed, sessionFailed } from './failFlag';
import { RoutingEngine } from './route';
import type { EngineProbe } from './wasm/engine';
import { chooseEngine, probe } from './select';

let engine: ChartEngine | null = null;

export function defaultChartEngine(): ChartEngine {
  if (engine !== null) return engine;
  const canvas2d = new Canvas2DEngine();
  const choice = chooseEngine(probe(sessionFailed()));
  if (choice.kind === 'wasm') {
    const load = (probe?: EngineProbe) =>
      import('./wasm/engine').then((m) =>
        m.loadBackend({
          forceT2: choice.forceT2,
          markFailed: markSessionFailed,
          ...(probe === undefined ? {} : { probe }),
        }),
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
    engine = new RoutingEngine(() => Promise.reject(new Error('canvas2d page')), canvas2d);
  } else {
    // `data-engine` names the engine of every chart canvas (plan #68 C1 §3.4).
    engine = {
      createFrame(canvas, init) {
        canvas.dataset['engine'] = 'canvas2d';
        return canvas2d.createFrame(canvas, init);
      },
    };
  }
  return engine;
}

export const ChartEngineContext = createContext<ChartEngine>(defaultChartEngine());
