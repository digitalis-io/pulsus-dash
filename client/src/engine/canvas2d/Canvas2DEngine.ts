/** The interim Canvas 2D chart engine (ADR-0014 §3, §4; T01-003 interim exception). */
import type { ChartEngine, ChartFrame, FrameInit } from '../api';
import type { Ctx2D } from './ctx';

export const MAX_SERIES = 500;

export class ChartUnsupportedError extends Error {}

export interface Canvas2DOptions {
  requestFrame?: (cb: () => void) => number;
  cancelFrame?: (id: number) => void;
  contextOf?: (c: HTMLCanvasElement) => Ctx2D | null;
  createCanvas?: () => HTMLCanvasElement;
  fonts?: Pick<FontFaceSet, 'load'> | null;
  now?: () => number;
}

export class Canvas2DEngine implements ChartEngine {
  constructor(_o?: Canvas2DOptions) {}
  createFrame(_canvas: HTMLCanvasElement, _init: FrameInit): ChartFrame {
    throw new Error('not implemented');
  }
}
