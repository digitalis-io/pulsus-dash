/** The chart engine the application uses (ADR-0014 §3). #68 changes only this file. */
import { createContext } from 'react';
import type { ChartEngine } from './api';
import { Canvas2DEngine } from './canvas2d/Canvas2DEngine';

let engine: ChartEngine | null = null;

export function defaultChartEngine(): ChartEngine {
  engine ??= new Canvas2DEngine();
  return engine;
}

export const ChartEngineContext = createContext<ChartEngine>(defaultChartEngine());
