import type { ThemeName } from '../api';

export const LEVEL_LABELS = ['level', 'detected_level'] as const;
export const LEVEL_COLOUR: Readonly<Record<string, number>> = {};

export function seriesColourIndex(_s: {
  key: string;
  labels: Readonly<Record<string, string>>;
}): number {
  throw new Error('not implemented');
}

export interface ThemeColours {
  background: string;
  grid: string;
  axisText: string;
  crosshair: string;
  brush: string;
  text: string;
  series: readonly string[];
  ramp: readonly string[];
}

export function themeColours(_t: ThemeName): ThemeColours {
  throw new Error('not implemented');
}

export function rampIndex(_count: number, _maxCount: number): number | null {
  throw new Error('not implemented');
}
