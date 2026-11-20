import type { FrameSummary, HoverEvent, HoverRow, PlotRect, VisSpec } from '../engine/api';
import type { FrameDataIssue } from '../data/frames';

export const TOOLTIP_ROWS = 20;

export function sortedRows(_rows: readonly HoverRow[]): HoverRow[] {
  throw new Error('not implemented');
}

export function rowWindow(_n: number, _selected: number): [number, number] {
  throw new Error('not implemented');
}

export function pointerWindowStart(_n: number, _yCss: number, _plot: PlotRect): number {
  throw new Error('not implemented');
}

export function summaryLabel(_spec: VisSpec, _s: FrameSummary, _tz: string): string {
  throw new Error('not implemented');
}

export function crosshairText(
  _spec: VisSpec,
  _h: HoverEvent | null,
  _tz: string,
  _selected = 0,
): string {
  throw new Error('not implemented');
}

export function issueText(_i: FrameDataIssue): string {
  throw new Error('not implemented');
}
