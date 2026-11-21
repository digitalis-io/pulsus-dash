/** Stub (tests first, plan #63 §5). */
import type { FrameData, ScalarFrame, SeriesFrame } from '../data/frames';
import type { VisKind, VisSpec } from '../engine/api';
import type { ExploreResult } from './autovis';

export type FramePlan =
  | { readonly spec: VisSpec; readonly data: FrameData; readonly notice: null }
  | { readonly spec: VisSpec; readonly data: null; readonly notice: 'noBuckets' }
  | { readonly spec: null; readonly data: null; readonly notice: 'string' };

export const SCALAR_KEY = '0000000000000000';

export function scalarSeries(_s: ScalarFrame): SeriesFrame {
  return {
    key: '',
    labels: {},
    timestamps: new Float64Array(0),
    values: new Float64Array(0),
  };
}

export function canIsolate(_vis: VisKind | null, _r: ExploreResult): boolean {
  return false;
}

export function framePlan(
  _vis: VisKind,
  _r: ExploreResult,
  _o: {
    readonly isolatedKey: string | null;
    readonly title: string;
    readonly rateApplied: boolean;
  },
): FramePlan {
  return { spec: null, data: null, notice: 'string' };
}
