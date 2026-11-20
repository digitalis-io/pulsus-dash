import type { HeatmapFrame, SeriesFrame } from '../data/frames';

export const LEVELS = ['error', 'warn', 'info', 'debug', 'trace'] as const;
export const LEVEL_BASE = [5, 20, 200, 80, 30] as const;

export function hash01(..._ints: number[]): number {
  throw new Error('not implemented');
}

export function synthLineValue(
  _seed: number,
  _j: number,
  _tMs: number,
  _base: number,
  _amp: number,
): number {
  throw new Error('not implemented');
}

export function synthLines(_o: {
  seed: number;
  series: number;
  points: number;
  fromMs: number;
  toMs: number;
  name: string;
  base: number;
  amp: number;
  gaps?: boolean;
}): SeriesFrame[] {
  throw new Error('not implemented');
}

export function synthHeatmap(_o: {
  seed: number;
  fromMs: number;
  toMs: number;
  columns: number;
  bounds: readonly number[];
}): HeatmapFrame {
  throw new Error('not implemented');
}

export function synthLevels(_o: {
  seed: number;
  fromMs: number;
  toMs: number;
  buckets: number;
  levels: readonly string[];
}): SeriesFrame[] {
  throw new Error('not implemented');
}
