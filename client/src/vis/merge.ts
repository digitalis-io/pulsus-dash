/** The T22-003 merge of one key's series. Stub until #173 Part 1. */
import type { SeriesFrame } from '../data/frames';

export function mergeKey(
  _series: readonly SeriesFrame[],
  _source: 'instant' | 'range',
): { timestamps: number[]; values: number[]; conflicts: number; infinite: number } {
  return { timestamps: [], values: [], conflicts: 0, infinite: 0 };
}
