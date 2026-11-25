/**
 * The chart engine the application uses (ADR-0014 §3). Canvas 2D unless the engine flag selects
 * the WASM engine and the page can run it (`select.ts`, D-SEL); then a routing engine that loads
 * the engine on the first chart frame and keeps Canvas 2D for the kinds it does not draw and for
 * every fallback (`route.ts`, D-ROUTE). #68 changes only this file of the seam.
 */
import { createContext } from 'react';
import type { ChartEngine } from './api';
import { Canvas2DEngine } from './canvas2d/Canvas2DEngine';
import { markSessionFailed, sessionFailed } from './failFlag';
import { RoutingEngine } from './route';
import { chooseEngine, probe } from './select';

let engine: ChartEngine | null = null;

export function defaultChartEngine(): ChartEngine {
  if (engine !== null) return engine;
  const canvas2d = new Canvas2DEngine();
  const choice = chooseEngine(probe(sessionFailed()));
  engine =
    choice.kind === 'wasm'
      ? new RoutingEngine(
          () =>
            import('./wasm/engine').then((m) =>
              m.loadBackend({ forceT2: choice.forceT2, markFailed: markSessionFailed }),
            ),
          canvas2d,
        )
      : canvas2d;
  return engine;
}

export const ChartEngineContext = createContext<ChartEngine>(defaultChartEngine());
