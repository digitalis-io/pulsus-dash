import { describe, expect, it } from 'vitest';
import logCasesRaw from '../../../wire/fixtures/json/log-step.json?raw';
import casesRaw from '../../../wire/fixtures/json/promql-step.json?raw';
import { rateWindowMs } from '../api/stub/plan';
import { LOG_LADDER_MS, PROM_LADDER_MS, logGrid, promGrid, type Grid } from './step';

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

  // #303 acceptance, as Go's TestStepAndWindow303.
  it.each([
    ['6 h at 560 px', 21_600_000, 560, 30_000, 60_000],
    ['15 min at 1 200 px', 900_000, 1200, 15_000, 60_000],
    ['1 h at 1 200 px', 3_600_000, 1200, 15_000, 60_000],
    ['24 h at 1 000 px', 86_400_000, 1000, 60_000, 75_000],
    ['30 d at 560 px', 2_592_000_000, 560, 3_600_000, 3_615_000],
  ])('%s: step and rate window', (_, span, w, step, window) => {
    const to = 1_767_225_600_000;
    const g = promGrid(to - span, to, w);
    expect(g?.stepMs).toBe(step);
    expect(rateWindowMs(step)).toBe(window);
  });
});
