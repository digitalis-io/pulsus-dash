import { describe, expect, it } from 'vitest';
import { formatValue, type Unit } from '../i18n/format';
import {
  crossed,
  displayText,
  nextStep,
  stateOf,
  thresholdLines,
  type Thresholds,
  type ThresholdStep,
} from './thresholds';

type Sv = ThresholdStep['state'];
const step = (state: Sv, value: number, label = ''): ThresholdStep => ({ value, state, label });

// Plan #64 Part B Appendix B.4: A, B, D and R.
const A: Thresholds = {
  direction: 'above',
  steps: [step('watch', 1.5), step('degraded', 2.5), step('failing', 4)],
};
const B: Thresholds = { direction: 'below', steps: [step('degraded', 99.5), step('failing', 95)] };
const D: Thresholds = { direction: 'above', steps: [step('degraded', 2), step('degraded', 3)] };
const R: Thresholds = {
  direction: 'above',
  steps: [step('failing', 4), step('watch', 1.5), step('degraded', 2.5)],
};

const s = (x: ThresholdStep | null): string | null =>
  x === null ? null : `${x.state} ${String(x.value)}`;

describe('unit:thresholds', () => {
  it.each<[string, Thresholds | null, number | null, string | null, string | null, string | null]>([
    ['T1', A, 1, null, 'ok', 'watch 1.5'],
    ['T2', A, 1.5, 'watch 1.5', 'watch', 'degraded 2.5'],
    ['T3', A, 3, 'degraded 2.5', 'degraded', 'failing 4'],
    ['T4', A, 4, 'failing 4', 'failing', null],
    ['T5', A, Infinity, 'failing 4', 'failing', null],
    ['T6', A, NaN, null, 'unknown', 'watch 1.5'],
    ['T7', A, null, null, 'unknown', 'watch 1.5'],
    ['T8', null, 3, null, null, null],
    ['T9', B, 99.9, null, 'ok', 'degraded 99.5'],
    ['T10', B, 96.1, 'degraded 99.5', 'degraded', 'failing 95'],
    ['T11', B, 95, 'failing 95', 'failing', null],
    ['T12', B, NaN, null, 'unknown', 'degraded 99.5'],
    ['T13', D, 3.5, 'degraded 3', 'degraded', null],
    ['T14', R, 3, 'degraded 2.5', 'degraded', 'failing 4'],
  ])('crossed and stateOf %s', (_id, t, v, wantCrossed, wantState, wantNext) => {
    expect(stateOf(t, v)).toBe(wantState);
    if (t === null) return;
    expect(s(crossed(t, v ?? NaN))).toBe(wantCrossed);
    expect(s(nextStep(t, v))).toBe(wantNext);
  });

  it('displayText', () => {
    const u: Unit = { kind: 'time', base: 's' };
    const above: Thresholds = { direction: 'above', steps: [step('watch', 1.5)] };
    const below: Thresholds = { direction: 'below', steps: [step('watch', 1.5)] };
    const fmt = formatValue(1.5, u);
    expect(displayText(above, step('watch', 1.5, ''), u)).toBe(`≥ ${fmt}`);
    expect(displayText(below, step('watch', 1.5, ''), u)).toBe(`≤ ${fmt}`);
    expect(displayText(below, step('watch', 1.5, '  '), u)).toBe(`≤ ${fmt}`);
    expect(displayText(above, step('watch', 1.5, 'SLO'), u)).toBe('SLO');
  });

  it('thresholdLines skips non-finite, keeps order', () => {
    const u: Unit = { kind: 'none' };
    const t: Thresholds = {
      direction: 'above',
      steps: [step('watch', 2), step('degraded', NaN), step('failing', 1, 'Cap')],
    };
    expect(thresholdLines(t, u)).toEqual([
      { value: 2, state: 'watch', label: displayText(t, step('watch', 2), u) },
      { value: 1, state: 'failing', label: 'Cap' },
    ]);
    expect(thresholdLines(null, u)).toEqual([]);
  });
});
