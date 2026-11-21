/** Stub (tests first, plan #63 §5). */
import type { Completeness, InstantResult, RangeResult } from '../data/decode';
import type { ScalarFrame, SeriesFrame } from '../data/frames';
import type { VisKind } from '../engine/api';

export type ExploreResult =
  | {
      readonly kind: 'series';
      readonly source: 'range' | 'instant';
      readonly series: readonly SeriesFrame[];
      readonly stepMs: number | null;
      readonly completeness: Completeness;
    }
  | { readonly kind: 'scalar'; readonly scalar: ScalarFrame; readonly completeness: Completeness }
  | { readonly kind: 'string'; readonly value: string; readonly completeness: Completeness };

export function fromRange(r: RangeResult): ExploreResult {
  return { kind: 'string', value: '', completeness: r.completeness };
}

export function fromInstant(r: InstantResult): ExploreResult {
  return { kind: 'string', value: '', completeness: r.completeness };
}

export interface AutoVis {
  readonly vis: VisKind | null;
  readonly rule: 5 | 6 | 7 | 14 | null;
}

export function autoVis(_i: {
  readonly histogram: boolean;
  readonly rateApplied: boolean;
  readonly result: ExploreResult;
}): AutoVis {
  return { vis: null, rule: null };
}

export type VisParam = VisKind | 'auto';

export function chooseVis(_param: VisParam, _auto: AutoVis): VisKind | null {
  return null;
}
