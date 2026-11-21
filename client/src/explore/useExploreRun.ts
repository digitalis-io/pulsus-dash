/** Stub (tests first, plan #63 Part C §3.1). */
import type { QueryLanguage } from '../editor/lang/types';
import type { ExploreResult } from '../vis/autovis';
import type { FramePlan } from '../vis/framePlan';
import type { MetricTypes, RunPlan } from './plan';

export const STRING_PLAN: FramePlan = { spec: null, data: null, notice: 'string' };
export type Refusal = 'queryTooLarge' | 'tooLong';
export interface RunOutcome {
  readonly text: string;
  readonly plan: RunPlan;
  readonly result: ExploreResult;
  readonly durationMs: number;
}
export interface ExploreRun {
  readonly plan: RunPlan | null;
  readonly refusal: Refusal | null;
  readonly shown: RunOutcome | null;
  readonly error: unknown;
  readonly fetching: boolean;
  rerun(): void;
}
export interface PlanInputs {
  readonly lang: QueryLanguage | null;
  readonly meta: MetricTypes | null;
  readonly stepMs: number | null;
  readonly rate: boolean;
}
export interface RunInput {
  readonly tenant: string;
  readonly q: string;
  readonly inputs: PlanInputs;
  readonly widthPx: number | null;
  readonly window: { readonly fromMs: number; readonly toMs: number };
}
const ni = (): never => {
  throw new Error('not implemented');
};
export function plannable(_i: PlanInputs): boolean {
  return ni();
}
export function planFor(_text: string, _i: PlanInputs): RunPlan | null {
  return ni();
}
export function refusalOf(_text: string, _plan: RunPlan | null): Refusal | null {
  return ni();
}
export function exploreRunKey(
  _tenant: string,
  _q: string,
  _plan: RunPlan,
  _w: { readonly fromMs: number; readonly toMs: number },
  _stepMs: number | null,
): readonly unknown[] {
  return ni();
}
export function useExploreRun(_a: RunInput): ExploreRun {
  return ni();
}
