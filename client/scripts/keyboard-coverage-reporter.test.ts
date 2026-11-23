import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FullConfig, FullResult, Suite } from '@playwright/test/reporter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COVERAGE_DIR,
  coverageFileName,
  KEYBOARD_PARTS,
  REQUIRED_STATES,
  type KeyboardPart,
} from '../e2e/keyboardParts.ts';
import KeyboardCoverageReporter, { runFilter } from './keyboard-coverage-reporter.ts';

const CLIENT = fileURLToPath(new URL('..', import.meta.url));
const ALL = /.*/;

function config(o: Partial<Record<'grep' | 'grepInvert' | 'shard', unknown>> = {}): FullConfig {
  return {
    grep: ALL,
    grepInvert: null,
    shard: null,
    projects: [{ name: 'p', grep: ALL, grepInvert: null }],
    ...o,
  } as unknown as FullConfig;
}

function suite(outputDir: string, parts: readonly KeyboardPart[]): Suite {
  const tests = [...parts.map((p) => ({ title: `${p} part` })), { title: 'another spec' }];
  return {
    suites: [{ project: () => ({ name: 'p', outputDir }), allTests: () => tests }],
  } as unknown as Suite;
}

function writeFiles(outputDir: string, parts: readonly KeyboardPart[], uncovered: boolean): void {
  const at = join(outputDir, COVERAGE_DIR);
  mkdirSync(at, { recursive: true });
  for (const [i, id] of parts.entries()) {
    const collected = id === 'K2' ? ['a › k', 'b › k'] : [];
    const operated = id === 'K4' ? (uncovered ? ['a › k'] : ['a › k', 'b › k']) : [];
    const visited = REQUIRED_STATES.filter((_, j) => j % parts.length === i);
    writeFileSync(
      join(at, coverageFileName('p', id)),
      JSON.stringify({ version: 1, project: 'p', part: id, collected, operated, visited }),
    );
  }
}

const dirs: string[] = [];
let stderr: string[] = [];
const argv = process.argv;
beforeEach(() => {
  stderr = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  });
  vi.stubEnv('E2E_SHARD', '');
  process.argv = ['node', 'playwright', 'test', '--project=p'];
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.argv = argv;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'kbd-reporter-'));
  dirs.push(d);
  return d;
}

async function run(outputDir: string, parts: readonly KeyboardPart[], c = config()) {
  const r = new KeyboardCoverageReporter();
  r.onBegin(c, suite(outputDir, parts));
  return await r.onEnd({ status: 'passed' } as FullResult);
}

describe('keyboard coverage reporter (#130, IA-015, T05-002)', () => {
  it('reporter fails a full run with an uncovered key', async () => {
    const out = tmp();
    writeFiles(out, KEYBOARD_PARTS, true);
    expect(await run(out, KEYBOARD_PARTS)).toEqual({ status: 'failed' });
    expect(stderr.join('')).toContain('keyboard-coverage p: keyboard-uncovered b › k');
  });

  it('reporter passes a covered full run', async () => {
    const out = tmp();
    writeFiles(out, KEYBOARD_PARTS, false);
    expect(await run(out, KEYBOARD_PARTS)).toBeUndefined();
    expect(stderr.join('')).not.toContain('keyboard-');
  });

  it('reporter does not check a filtered run', async () => {
    vi.stubEnv('E2E_SHARD', 'kbd-b');
    expect(await run(tmp(), ['K3'])).toBeUndefined();
    expect(stderr.join('')).toContain(
      'keyboard-coverage p: not checked (E2E_SHARD=kbd-b; run has K3)',
    );
  });

  it('reporter fails a full run missing a part', async () => {
    const out = tmp();
    const parts: KeyboardPart[] = ['K1', 'K2', 'K3', 'K5'];
    writeFiles(out, parts, false);
    expect(await run(out, parts)).toEqual({ status: 'failed' });
    expect(stderr.join('')).toContain('keyboard-coverage p: keyboard-part-missing K4');
  });

  it('runFilter classifies commands', () => {
    const f = (args: string[], env: NodeJS.ProcessEnv = {}, c = config()) =>
      runFilter(c, env, ['node', 'playwright', 'test', ...args]);
    expect(f([])).toBeUndefined();
    expect(f(['--project=firefox'])).toBeUndefined();
    expect(f(['--project', 'firefox', '--workers', '4'])).toBeUndefined();
    expect(f(['--grep', 'K3 '])).toBe('--grep');
    expect(f(['-g', 'x'])).toBe('-g');
    expect(f(['keyboard.spec.ts:40'])).toBe('files keyboard.spec.ts:40');
    expect(f(['--list'])).toBe('--list');
    expect(f([], { E2E_SHARD: 'rest' })).toBe('E2E_SHARD=rest');
    expect(f([], {}, config({ grepInvert: /@kbd/ }))).toBe('grep');
    expect(f([], {}, config({ shard: { current: 1, total: 2 } }))).toBe('shard');
  });

  it('full playwright command fails on a gap or a missing part', () => {
    const pw = (fixture: string, extra: string[] = []) => {
      const out = tmp();
      const env: NodeJS.ProcessEnv = { ...process.env, KBD_FIXTURE: fixture, KBD_FIXTURE_OUT: out };
      delete env['E2E_SHARD'];
      const r = spawnSync(
        'npx',
        [
          '--no-install',
          'playwright',
          'test',
          '-c',
          'scripts/fixtures/kbd-reporter/playwright.config.ts',
          ...extra,
        ],
        { cwd: CLIENT, env, encoding: 'utf8' },
      );
      return { code: r.status, err: `${r.stderr}${r.stdout}` };
    };
    const uncovered = pw('uncovered');
    expect(uncovered.code, uncovered.err).toBe(1);
    expect(uncovered.err).toContain('keyboard-uncovered');
    const covered = pw('covered');
    expect(covered.code, covered.err).toBe(0);
    const noK4 = pw('no-k4');
    expect(noK4.code, noK4.err).toBe(1);
    expect(noK4.err).toContain('keyboard-part-missing K4');
    const grep = pw('no-k4', ['--grep', 'K3 ']);
    expect(grep.code, grep.err).toBe(0);
    expect(grep.err).toContain('not checked');
  }, 180_000);
});
