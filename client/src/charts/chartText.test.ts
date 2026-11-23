import { describe, expect, it } from 'vitest';
import type { FrameSummary, VisSpec } from '../engine/api';
import { summaryLabel } from './chartText';

const FROM = Date.UTC(2026, 10, 19, 12);
const SUMMARY: FrameSummary = {
  kind: 'line',
  seriesTotal: 1,
  seriesShown: 1,
  fromMs: FROM,
  toMs: FROM + 3_600_000,
  min: 1,
  max: 2,
  last: 2,
  plot: { x: 0, y: 0, width: 100, height: 100 },
  valueAxis: { min: 0, max: 2, manual: false },
  thresholdLabels: [],
};

describe('summaryLabel thresholds (#64 Part B §3.9.1)', () => {
  it('summary lists every threshold', () => {
    const spec: VisSpec = {
      kind: 'line',
      title: 'T',
      unit: { kind: 'none' },
      thresholds: [
        { value: 2, state: 'degraded', label: 'SLO' },
        { value: 1, state: 'watch', label: '≥ 1' },
      ],
    };
    expect(summaryLabel(spec, SUMMARY, 'Europe/London')).toMatch(
      / Thresholds: Degraded SLO; Watch ≥ 1\.$/,
    );
  });

  it('no thresholds: no list', () => {
    const spec: VisSpec = { kind: 'line', title: 'T', unit: { kind: 'none' } };
    expect(summaryLabel(spec, SUMMARY, 'Europe/London')).not.toContain('Thresholds');
  });
});
