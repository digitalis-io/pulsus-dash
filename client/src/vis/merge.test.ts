/**
 * The shared T22-003 merge (plan #173 Part 1 §4.1, `unit:category-duplicates`): the histogram
 * (T21) and the categorical rows count the same conflicts.
 */
import { describe, expect, it } from 'vitest';
import type { SeriesFrame } from '../data/frames';
import type { Unit } from '../i18n/format';
import { COMPLETE, fkey } from '../test/categoryFixtures';
import type { ExploreResult } from './autovis';
import { mergeKey } from './merge';
import { categoryRows } from './reduce';
import { histogram, type HistogramOptions } from './transforms/histogram';

const NONE: Unit = { kind: 'none' };
const K = fkey(7);
const [T0, T1, T2] = [0, 1000, 2000];

function at(pairs: readonly (readonly [number, number])[]): SeriesFrame {
  return {
    key: K,
    labels: { version: '2.31' },
    timestamps: new Float64Array(pairs.map((p) => p[0])),
    values: new Float64Array(pairs.map((p) => p[1])),
  };
}

const A = at([
  [T0, 5],
  [T2, 7],
]);
const B = at([
  [T0, 6],
  [T1, 9],
]);

const HIST: HistogramOptions = {
  binMode: 'auto',
  binCount: 20,
  binWidth: null,
  scale: 'linear',
  groupBy: null,
  groupMode: 'stack',
  cumulative: 'none',
  unit: NONE,
};

function histConflicts(series: readonly SeriesFrame[], source: 'instant' | 'range'): number {
  const h = histogram(series, source, HIST, COMPLETE);
  if (h.kind === 'frame') return h.frame.coverage.conflicts;
  if (h.kind === 'empty' || h.kind === 'noneShown') return h.coverage.conflicts;
  throw new Error(h.kind);
}

function rowConflicts(series: readonly SeriesFrame[], source: 'instant' | 'range'): number {
  const r: ExploreResult = { kind: 'series', source, series, stepMs: null, completeness: COMPLETE };
  return categoryRows(r, null, { reducer: 'last', categoryBy: '', sort: 'none', thresholds: null })
    .conflicts;
}

describe('unit:category-duplicates (mergeKey)', () => {
  it('instant: the latest timestamp wins; only a tie there conflicts', () => {
    expect(mergeKey([A, B], 'instant')).toEqual({
      timestamps: [T2],
      values: [7],
      conflicts: 0,
      infinite: 0,
    });
    const tie = [at([[T1, 4]]), at([[T1, 8]])];
    expect(mergeKey(tie, 'instant')).toEqual({
      timestamps: [T1],
      values: [8],
      conflicts: 1,
      infinite: 0,
    });
  });

  it('range: joined by timestamp, ascending, the max on a shared one', () => {
    expect(mergeKey([A, B], 'range')).toEqual({
      timestamps: [T0, T1, T2],
      values: [6, 9, 7],
      conflicts: 1,
      infinite: 0,
    });
    expect(mergeKey([A], 'range')).toEqual({
      timestamps: [T0, T2],
      values: [5, 7],
      conflicts: 0,
      infinite: 0,
    });
  });

  it('the histogram and the categorical rows count the same conflicts', () => {
    const cases: [readonly SeriesFrame[], 'instant' | 'range', number][] = [
      [[A, B], 'instant', 0],
      [[at([[T1, 4]]), at([[T1, 8]])], 'instant', 1],
      [[A, B], 'range', 1],
    ];
    for (const [series, source, want] of cases) {
      expect(rowConflicts(series, source), source).toBe(want);
      expect(histConflicts(series, source), source).toBe(want);
    }
  });
});
