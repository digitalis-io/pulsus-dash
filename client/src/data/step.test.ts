import { describe, expect, it } from 'vitest';
import casesRaw from '../../../wire/fixtures/json/promql-step.json?raw';
import { LADDER_MS, promGrid } from './step';

interface StepCase {
  from: number;
  to: number;
  width_px: number;
  step?: number;
  start?: number;
  end?: number;
  error?: string;
}

describe('unit:promql-step (TS half)', () => {
  it('has the Go ladder', () => {
    expect(LADDER_MS).toEqual([
      1e3, 5e3, 10e3, 15e3, 30e3, 60e3, 300e3, 900e3, 3600e3, 21600e3, 86400e3,
    ]);
  });

  it('matches every case of promql-step.json', () => {
    const cases = JSON.parse(casesRaw) as StepCase[];
    expect(cases).toHaveLength(14);
    for (const c of cases) {
      const g = promGrid(c.from, c.to, c.width_px);
      if (c.error === 'range') {
        expect(g, `${String(c.from)}..${String(c.to)}`).toBeNull();
      } else {
        expect(g, `${String(c.from)}..${String(c.to)} @${String(c.width_px)}`).toEqual({
          startMs: c.start,
          endMs: c.end,
          stepMs: c.step,
        });
      }
    }
  });
});
