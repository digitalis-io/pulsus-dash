/* eslint-disable @typescript-eslint/no-unused-vars -- stub until the implementation */
/** Stub (plan #64 Part B §3.3). */
import type { PanelSpec } from '../api/types';
import type { ThresholdLine, ThresholdState } from '../engine/api';
import type { Unit } from '../i18n/format';
import type { State } from '../theme/stateEncoding';

export type Thresholds = NonNullable<PanelSpec['vis']['thresholds']>;
export type ThresholdStep = Thresholds['steps'][number];
export const MAX_THRESHOLD_STEPS = 8;
/** watch 1 < degraded 2 < failing 3. */
export const SEVERITY: Readonly<Record<ThresholdState, number>> = {
  watch: 1,
  degraded: 2,
  failing: 3,
};

export function crosses(_t: Thresholds, _s: ThresholdStep, _v: number): boolean {
  return false;
}
export function crossed(_t: Thresholds, _v: number): ThresholdStep | null {
  return null;
}
export function stateOf(_t: Thresholds | null, _v: number | null): State | null {
  return null;
}
export function nextStep(_t: Thresholds, _v: number | null): ThresholdStep | null {
  return null;
}
export function displayText(_t: Thresholds, _s: ThresholdStep, _unit: Unit): string {
  return '';
}
export function thresholdLines(_t: Thresholds | null, _unit: Unit): readonly ThresholdLine[] {
  return [];
}
