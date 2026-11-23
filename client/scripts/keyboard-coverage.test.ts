import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  COVERAGE_DIR,
  coverageFileName,
  KEYBOARD_PARTS,
  REQUIRED_STATES,
  type KeyboardPart,
  type PartCoverage,
} from '../e2e/keyboardParts.ts';
import { checkKeyboardCoverage, checkKeyboardCoverageDir } from './keyboard-coverage.ts';
import { InputError } from './lib/report.ts';

const P = 'p';

function part(id: KeyboardPart, o: Partial<PartCoverage> = {}): PartCoverage {
  return { version: 1, project: P, part: id, collected: [], operated: [], visited: [], ...o };
}

/** Five parts: `a › k` collected in K1 and operated in K3; the required states spread over all. */
function covered(): PartCoverage[] {
  return KEYBOARD_PARTS.map((id, i) =>
    part(id, {
      collected: id === 'K1' ? ['a › k'] : [],
      operated: id === 'K3' ? ['a › k'] : [],
      visited: REQUIRED_STATES.filter((_, j) => j % KEYBOARD_PARTS.length === i),
    }),
  );
}

const ids = (parts: readonly unknown[]): string[] =>
  checkKeyboardCoverage(parts, P).map((f) => `${f.rule} ${f.subject ?? ''}`);

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeParts(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'kbd-coverage-'));
  dirs.push(dir);
  const at = join(dir, 'shard-x', COVERAGE_DIR);
  mkdirSync(at, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(at, name), text);
  return dir;
}

describe('keyboard coverage over the parts (#130, IA-015, T05-002)', () => {
  it('union across parts covers', () => {
    expect(ids(covered())).toEqual([]);
  });

  it('missing part', () => {
    expect(ids(covered().filter((p) => p.part !== 'K4'))).toEqual(['keyboard-part-missing K4']);
  });

  it('duplicate part', () => {
    const parts = covered();
    expect(ids([...parts, part('K2')])).toEqual(['keyboard-part-duplicate K2']);
  });

  it('uncovered key', () => {
    const parts = covered();
    parts[1] = part('K2', { collected: ['b › k'] });
    expect(ids(parts)).toEqual(['keyboard-uncovered b › k']);
  });

  it('unvisited state', () => {
    const parts = covered().map((p) => ({
      ...p,
      visited: p.visited.filter((s) => s !== 'session-error'),
    }));
    expect(ids(parts)).toEqual(['keyboard-unvisited session-error']);
  });

  it('bad input is exit 2', () => {
    const files = Object.fromEntries(
      covered().map((p) => [coverageFileName(P, p.part), JSON.stringify(p)]),
    );
    const bad = writeParts({ ...files, [coverageFileName(P, 'K2')]: '{ not json' });
    expect(() => checkKeyboardCoverageDir(bad, P)).toThrow(InputError);
    expect(() =>
      checkKeyboardCoverage([...covered().slice(1), { ...part('K1'), version: 2 }], P),
    ).toThrow(InputError);
    expect(() =>
      checkKeyboardCoverage([...covered().slice(1), { ...part('K1'), project: 'q' }], P),
    ).toThrow(InputError);
    const empty = covered().map((p) => ({ ...p, collected: [], operated: [] }));
    expect(ids(empty)).toEqual(['keyboard-empty p']);
    // The directory form finds the files at any depth (one directory per CI shard).
    expect(checkKeyboardCoverageDir(writeParts(files), P)).toEqual([]);
  });
});
