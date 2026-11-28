/** Legend name templates (board spec v10, #204): stub. */
import type { FrameData, Labels } from '../data/frames';
import type { HoverEvent } from '../engine/api';
import type { ExploreResult } from './autovis';

export const MAX_LEGEND_FORMAT = 256;

export function isLegendFormat(_s: string): boolean {
  return false;
}

export function renderLegendFormat(_format: string, _labels: Labels): string {
  return '';
}

export function displayName(_labels: Labels, _format: string | null): string {
  return '';
}

export type SeriesNames = ReadonlyMap<string, string>;

export function seriesNames(_data: FrameData, _format: string | null): SeriesNames | null {
  return null;
}

export function namedHover(h: HoverEvent | null, _names: SeriesNames | null): HoverEvent | null {
  return h;
}

export function resultLabelNames(_r: ExploreResult): string[] {
  return [];
}
