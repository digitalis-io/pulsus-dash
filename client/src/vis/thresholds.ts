/**
 * The one threshold evaluator of the client (plan #64 Part B §3.3; T02 §4.5, T02-018 in the
 * interim client): every value gets one state for the legend highlight, the stat chip and the
 * threshold labels. Thresholds are absolute steps, worse `above` or `below` their value.
 */
import type { PanelSpec } from '../api/types';
import type { ThresholdLine, ThresholdState } from '../engine/api';
import { formatValue, type Unit } from '../i18n/format';
import type { State } from '../theme/stateEncoding';

export type Thresholds = NonNullable<PanelSpec['vis']['thresholds']>;
export type ThresholdStep = Thresholds['steps'][number];
export const MAX_THRESHOLD_STEPS = 8;
/** watch 1 < degraded 2 < failing 3. */
export const SEVERITY: Readonly<Record<ThresholdState, number>> = Object.freeze({
  watch: 1,
  degraded: 2,
  failing: 3,
});

/** Above: v ≥ s.value; below: v ≤ s.value. False when v or s.value is NaN; ±Inf compare normally. */
export function crosses(t: Thresholds, s: ThresholdStep, v: number): boolean {
  return t.direction === 'above' ? v >= s.value : v <= s.value;
}

/** Further along the direction: above, the larger value; below, the smaller. */
const further = (t: Thresholds, a: ThresholdStep, b: ThresholdStep): boolean =>
  t.direction === 'above' ? a.value > b.value : a.value < b.value;

/** The most severe step v crosses; ties go to the furthest (above: largest value; below: smallest). */
export function crossed(t: Thresholds, v: number): ThresholdStep | null {
  let best: ThresholdStep | null = null;
  for (const s of t.steps) {
    if (!crosses(t, s, v)) continue;
    if (
      best === null ||
      SEVERITY[s.state] > SEVERITY[best.state] ||
      (SEVERITY[s.state] === SEVERITY[best.state] && further(t, s, best))
    ) {
      best = s;
    }
  }
  return best;
}

/** null without thresholds; 'unknown' for null/NaN; 'ok' when nothing is crossed; else its state. */
export function stateOf(t: Thresholds | null, v: number | null): State | null {
  if (t === null) return null;
  if (v === null || Number.isNaN(v)) return 'unknown';
  return crossed(t, v)?.state ?? 'ok';
}

/**
 * The step v reaches next: above, the smallest value > v; below, the largest value < v. For a
 * null or NaN v: above, the smallest value; below, the largest. null when every step is crossed.
 */
export function nextStep(t: Thresholds, v: number | null): ThresholdStep | null {
  const known = v !== null && !Number.isNaN(v);
  let best: ThresholdStep | null = null;
  for (const s of t.steps) {
    if (Number.isNaN(s.value)) continue;
    if (known && (t.direction === 'above' ? !(s.value > v) : !(s.value < v))) continue;
    // The nearest ahead: above, the smaller value; below, the larger.
    if (best === null || further(t, best, s)) best = s;
  }
  return best;
}

/** The label if it has a non-space character; else `≥ ${formatValue(value, unit)}` (above) / `≤ …`. */
export function displayText(t: Thresholds, s: ThresholdStep, unit: Unit): string {
  if (s.label.trim() !== '') return s.label;
  return `${t.direction === 'above' ? '≥' : '≤'} ${formatValue(s.value, unit)}`;
}

/** Seam lines for line and bars: steps with a finite value, in spec order, label = displayText. */
export function thresholdLines(t: Thresholds | null, unit: Unit): readonly ThresholdLine[] {
  if (t === null) return [];
  return t.steps
    .filter((s) => Number.isFinite(s.value))
    .map((s) => ({ value: s.value, state: s.state, label: displayText(t, s, unit) }));
}
