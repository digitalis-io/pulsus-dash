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

const CLEAN = {
  'index.html': '<!doctype html>',
  'assets/index-a.js': 'export const a = 1;',
  'assets/dash-engine-b.wasm': Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]),
};

describe('ci:probe-absent (T03-024)', () => {
  it('finds each test hook in a release build', () => {
    const fault = '__pulsus_engine_' + 'fault__';
    const d = dist({
      ...CLEAN,
      'assets/a-1.js': 'globalThis.__dashProbe = {};',
      'assets/b-2.js': `console.warn("${fault}")`,
      'assets/dash-engine-c.wasm': Buffer.concat([Buffer.from([0, 0x61, 0x73, 0x6d]), Buffer.from(fault)]),
    });
    const r = checkProbeAbsent(d);
    expect(r.map((f) => f.rule)).toEqual(['probe-in-release', 'probe-in-release', 'probe-in-release']);
    expect(r.map((f) => f.file).sort()).toEqual([
      'assets/a-1.js',
      'assets/b-2.js',
      'assets/dash-engine-c.wasm',
    ]);
  });
  it('a clean build has none', () => {
    expect(checkProbeAbsent(dist(CLEAN))).toEqual([]);
  });
});
