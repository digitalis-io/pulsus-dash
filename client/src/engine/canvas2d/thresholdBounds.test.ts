/// <reference types="node" />
/**
 * Thresholds at the ends of the accepted range draw and stay bounded (plan #64 Part B §3.2, #97).
 * Each case runs `scripts/threshold-draw-probe.ts` in a child process with a hard timeout: a draw
 * that never finishes is killed and fails here instead of hanging the run.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface ProbeOut {
  readonly valueAxis: { readonly min: number; readonly max: number } | null;
  readonly dashed: number;
}

function probe(name: 'max' | 'tiny'): ProbeOut {
  const r = spawnSync(process.execPath, [join('scripts', 'threshold-draw-probe.ts'), name], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 5000,
    killSignal: 'SIGKILL',
  });
  expect(r.signal, `probe ${name} was killed: ${r.stderr}`).toBeNull();
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout) as ProbeOut;
}

describe('unit:threshold-bounds', () => {
  it('thresholds at ±1e15 draw and stay bounded', () => {
    const out = probe('max');
    const a = out.valueAxis;
    expect(a, 'no value axis').not.toBeNull();
    if (a === null) throw new Error('no value axis');
    expect(Number.isFinite(a.min) && Number.isFinite(a.max)).toBe(true);
    expect(a.min).toBeLessThanOrEqual(-1e15);
    expect(a.max).toBeGreaterThanOrEqual(1e15);
    expect(a.max - a.min).toBeLessThanOrEqual(4e15);
    expect(out.dashed).toBe(2);
  }, 20_000);

  it('a 1e-9 threshold over zero data draws and stays bounded', () => {
    const out = probe('tiny');
    const a = out.valueAxis;
    expect(a, 'no value axis').not.toBeNull();
    if (a === null) throw new Error('no value axis');
    expect(Number.isFinite(a.min) && Number.isFinite(a.max)).toBe(true);
    expect(a.min).toBeLessThanOrEqual(0);
    expect(a.max).toBeGreaterThanOrEqual(1e-9);
    expect(a.max - a.min).toBeLessThanOrEqual(1);
    expect(out.dashed).toBe(1);
  }, 20_000);
});
