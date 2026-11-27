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
  it('engine_probe_input in a .wasm fails a release and a fault tree; --expect-probe requires it (plan #68 C2a1)', () => {
    const PROBE = Buffer.concat([WASM, Buffer.from('engine_probe_' + 'input')]);
    const sites = {
      'assets/r.js': `x("${SENTINEL}:route")`,
      'assets/b.js': `x("${SENTINEL}:boot")`,
      'assets/w/x.js': `x("${SENTINEL}:worker")`,
    };
    // Release: the probe export in the wasm is a finding; the name in a script is not.
    const release = checkProbeAbsent(
      dist({
        ...CLEAN,
        'assets/dash-engine-b.wasm': PROBE,
        'assets/glue.js': 'engine_probe_input',
      }),
    );
    expect(release.map((f) => [f.rule, f.file, f.subject])).toEqual([
      ['probe-in-release', 'assets/dash-engine-b.wasm', 'engine_probe_input'],
    ]);
    // The fault build serves the release wasm: the probe export there is a finding too.
    const fault = checkProbeAbsent(
      dist({ ...CLEAN, ...sites, 'assets/dash-engine-b.wasm': PROBE }),
      { expectFaults: true },
    );
    expect(fault.map((f) => [f.rule, f.subject])).toEqual([
      ['probe-in-release', 'engine_probe_input'],
    ]);
    // The probe build must carry it (and, since plan #68 C2d1, engine_probe_synth).
    const missing = checkProbeAbsent(dist({ ...CLEAN, ...sites }), {
      expectFaults: true,
      expectProbe: true,
    });
    expect(missing.map((f) => [f.rule, f.subject])).toEqual([
      ['probe-missing', 'engine_probe_input'],
      ['probe-missing', 'engine_probe_' + 'synth'],
      ['probe-missing', 'engine_probe_' + 'chunk'],
    ]);
    const both = Buffer.concat([
      PROBE,
      Buffer.from('engine_probe_' + 'synth'),
      Buffer.from('engine_probe_' + 'chunk'),
    ]);
    expect(
      checkProbeAbsent(dist({ ...CLEAN, ...sites, 'assets/dash-engine-b.wasm': both }), {
        expectFaults: true,
        expectProbe: true,
      }),
    ).toEqual([]);
  });
  it('engine_probe_synth is a probe export too: a release tree fails, the probe build needs it (plan #68 C2d1)', () => {
    const SYNTH = 'engine_probe_' + 'synth';
    const INPUT = 'engine_probe_' + 'input';
    const CHUNK = 'engine_probe_' + 'chunk';
    const release = checkProbeAbsent(
      dist({
        ...CLEAN,
        'assets/dash-engine-b.wasm': Buffer.concat([WASM, Buffer.from(SYNTH)]),
      }),
    );
    expect(release.map((f) => [f.rule, f.file, f.subject])).toEqual([
      ['probe-in-release', 'assets/dash-engine-b.wasm', SYNTH],
    ]);
    const sites = {
      'assets/r.js': `x("${SENTINEL}:route")`,
      'assets/b.js': `x("${SENTINEL}:boot")`,
      'assets/w/x.js': `x("${SENTINEL}:worker")`,
    };
    // The probe build without the synth export misses it.
    const noSynth = checkProbeAbsent(
      dist({
        ...CLEAN,
        ...sites,
        'assets/dash-engine-b.wasm': Buffer.concat([WASM, Buffer.from(INPUT)]),
      }),
      { expectFaults: true, expectProbe: true },
    );
    expect(noSynth.map((f) => [f.rule, f.subject])).toEqual([
      ['probe-missing', SYNTH],
      ['probe-missing', CHUNK],
    ]);
    expect(
      checkProbeAbsent(
        dist({
          ...CLEAN,
          ...sites,
          'assets/dash-engine-b.wasm': Buffer.concat([WASM, Buffer.from(INPUT + SYNTH + CHUNK)]),
        }),
        { expectFaults: true, expectProbe: true },
      ),
    ).toEqual([]);
  });
  it('engine_probe_chunk alone in a release tree is a finding (plan #68 C2d1)', () => {
    const CHUNK = 'engine_probe_' + 'chunk';
    const r = checkProbeAbsent(
      dist({ ...CLEAN, 'assets/dash-engine-b.wasm': Buffer.concat([WASM, Buffer.from(CHUNK)]) }),
    );
    expect(r.map((f) => [f.rule, f.file, f.subject])).toEqual([
      ['probe-in-release', 'assets/dash-engine-b.wasm', CHUNK],
    ]);
  });
});
