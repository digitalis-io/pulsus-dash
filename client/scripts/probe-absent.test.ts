import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkProbeAbsent } from './probe-absent.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function dist(files: Record<string, string | Buffer>): string {
  const d = mkdtempSync(join(tmpdir(), 'probe-absent-'));
  dirs.push(d);
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(d, p)), { recursive: true });
    writeFileSync(join(d, p), c);
  }
  return d;
}

const SENTINEL = '__pulsus_engine_' + 'fault__';
const WASM = Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
const CLEAN = {
  'index.html': '<!doctype html>',
  'assets/index-a.js': 'export const a = 1;',
  'assets/dash-engine-b.wasm': WASM,
};

describe('ci:probe-absent (T03-024)', () => {
  it('finds each test hook anywhere in a release tree', () => {
    const d = dist({
      ...CLEAN,
      'assets/a.js': 'globalThis.__dashProbe = {};',
      'assets/w/x.js': `console.warn("${SENTINEL}:worker")`,
      'assets/dash-engine-c.wasm': Buffer.concat([WASM, Buffer.from(`${SENTINEL}:route`)]),
    });
    const r = checkProbeAbsent(d);
    expect(r.map((f) => f.rule)).toEqual([
      'probe-in-release',
      'probe-in-release',
      'probe-in-release',
    ]);
    expect(r.map((f) => f.file).sort()).toEqual([
      'assets/a.js',
      'assets/dash-engine-c.wasm',
      'assets/w/x.js',
    ]);
  });
  it('a clean tree has none', () => {
    expect(checkProbeAbsent(dist(CLEAN))).toEqual([]);
  });
  it('--expect-faults needs every fault site', () => {
    const all = {
      ...CLEAN,
      'assets/r.js': `x("${SENTINEL}:route")`,
      'assets/b.js': `x("${SENTINEL}:boot")`,
      'assets/w/x.js': `x("${SENTINEL}:worker")`,
    };
    expect(checkProbeAbsent(dist(all), { expectFaults: true })).toEqual([]);
    const noBoot = Object.fromEntries(Object.entries(all).filter(([k]) => k !== 'assets/b.js'));
    const r = checkProbeAbsent(dist(noBoot), { expectFaults: true });
    expect(r.map((f) => [f.rule, f.subject])).toEqual([['fault-site-missing', 'boot']]);
  });
});
