import { describe, expect, it } from 'vitest';
import logCasesRaw from '../../../wire/fixtures/json/log-step.json?raw';
import atCasesRaw from '../../../wire/fixtures/json/promql-step-at.json?raw';
import casesRaw from '../../../wire/fixtures/json/promql-step.json?raw';
import { LOG_LADDER_MS, PROM_LADDER_MS, logGrid, promGrid, promGridAt, type Grid } from './step';

interface StepCase {
  from: number;
  to: number;
  width_px: number;
  step?: number;
  start?: number;
  end?: number;
  error?: string;
}

function check(raw: string, n: number, grid: (f: number, t: number, w: number) => Grid | null) {
  const cases = JSON.parse(raw) as StepCase[];
  expect(cases).toHaveLength(n);
  for (const c of cases) {
    const g = grid(c.from, c.to, c.width_px);
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
}

describe('unit:promql-step (TS half)', () => {
  it('has the Go ladders', () => {
    expect(PROM_LADDER_MS).toEqual([
      15e3, 30e3, 60e3, 120e3, 300e3, 600e3, 720e3, 900e3, 1800e3, 3600e3, 7200e3, 10800e3, 21600e3,
      43200e3, 86400e3,
    ]);
    expect(LOG_LADDER_MS).toEqual([
      1e3, 5e3, 10e3, 15e3, 30e3, 60e3, 300e3, 900e3, 3600e3, 21600e3, 86400e3,
    ]);
  });

  it('matches every case of promql-step.json', () => {
    check(casesRaw, 21, promGrid);
  });

  it('matches every case of log-step.json (unit:log-step)', () => {
    check(logCasesRaw, 14, logGrid);
  });
});

describe('promGridAt parity (#304 §A.1)', () => {
  it('matches every case of promql-step-at.json', () => {
    const cases = JSON.parse(atCasesRaw) as (StepCase & { step_ms: number })[];
    expect(cases).toHaveLength(10);
    for (const c of cases) {
      const g = promGridAt(c.from, c.to, c.step_ms);
      const name = `${String(c.from)}..${String(c.to)} @${String(c.step_ms)}`;
      if (c.error !== undefined) expect(g, name).toBeNull();
      else expect(g, name).toEqual({ startMs: c.start, endMs: c.end, stepMs: c.step_ms });
    }
  });
});
