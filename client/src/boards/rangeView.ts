/** Stub (tests first, #304). */
import type { Run } from '../data/buckets';
import type { RangeView } from '../data/rangeStore';
import type { TimeWindow } from '../engine/api';

export function planRangeView(_a: {
  readonly tenant: string;
  readonly scope: string;
  readonly text: string;
  readonly vars: string;
  readonly rate: boolean;
  readonly line: boolean;
  readonly window: TimeWindow;
  readonly widthPx: number;
  readonly epoch: number;
  readonly anchorMs: number;
}): RangeView | null {
  return null;
}
export const chunkable = (_text: string): boolean => true;
export const usesRangeMacro = (_text: string): boolean => false;

export interface LadderLevel {
  readonly factor: 3 | 9;
  readonly stepMs: number;
  readonly run: Run;
}
export function ladderOf(_v: RangeView, _widthPx: number): readonly LadderLevel[] {
  return [];
}
export function coarseStep(_v: RangeView, _widthPx: number): number | null {
  return null;
}
