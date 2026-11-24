import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COVERAGE_DIR,
  coverageFileName,
  DRAIN_SKIP,
  DRAIN_SKIP_ONLY,
  drainPending,
  drainSkip,
  KEYBOARD_PARTS,
  partOfTitle,
  REQUIRED_STATES,
  SINGLE_TEST_ORDER,
  stableRead,
  type KeyboardPart,
  type PartCoverage,
} from '../e2e/keyboardParts.ts';
import { routeOf } from '../e2e/keyboardCoverage.ts';
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

const NO_SKIP = Object.fromEntries(KEYBOARD_PARTS.map((id) => [id, []])) as unknown as Record<
  KeyboardPart,
  readonly string[]
>;

const ids = (
  parts: readonly unknown[],
  skip = NO_SKIP,
  only: Partial<Record<KeyboardPart, Record<string, readonly string[]>>> = {},
  project = P,
): string[] =>
  checkKeyboardCoverage(parts, project, skip, only).map((f) => `${f.rule} ${f.subject ?? ''}`);

/** `covered()` with each part collecting its `DRAIN_SKIP` keys, which K1 (first) operates. */
function backed(): PartCoverage[] {
  return covered().map((p) => ({
    ...p,
    collected: [...p.collected, ...DRAIN_SKIP[p.part]],
    operated: [...p.operated, ...(p.part === 'K1' ? Object.values(DRAIN_SKIP).flat() : [])],
  }));
}

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
    // K4's states visited by K1, so only the part is missing.
    const parts = covered();
    const k4 = parts.find((p) => p.part === 'K4')?.visited ?? [];
    parts[0] = { ...(parts[0] ?? part('K1')), visited: [...(parts[0]?.visited ?? []), ...k4] };
    expect(ids(parts.filter((p) => p.part !== 'K4'))).toEqual(['keyboard-part-missing K4']);
  });

  it('duplicate part', () => {
    const parts = covered();
    expect(ids([...parts, part('K2')])).toEqual(['keyboard-part-duplicate K2']);
  });

  it('uncovered key', () => {
    const parts = covered();
    parts[1] = { ...(parts[1] ?? part('K2')), collected: ['b › k'] };
    expect(ids(parts)).toEqual(['keyboard-uncovered b › k']);
  });

  it('unvisited state', () => {
    const parts = covered().map((p) => ({
      ...p,
      visited: p.visited.filter((s) => s !== 'session-error'),
    }));
    expect(ids(parts)).toEqual(['keyboard-unvisited session-error']);
  });

  it('skip must be backed by an earlier part and collected', () => {
    const skip = { ...NO_SKIP, K4: ['s › x'] };
    const at = (o: Partial<Record<KeyboardPart, Partial<PartCoverage>>>): PartCoverage[] =>
      covered().map((p) => ({ ...p, ...o[p.part] }));
    // K3 runs before K4 in the single test, so its operating backs K4's skip.
    const ok = at({ K3: { operated: ['a › k', 's › x'] }, K4: { collected: ['s › x'] } });
    expect(ids(ok, skip)).toEqual([]);
    // K2 runs after K4: its operating does not back K4's skip.
    const late = at({ K2: { operated: ['s › x'] }, K4: { collected: ['s › x'] } });
    expect(ids(late, skip)).toEqual(['keyboard-skip-unbacked K4 s › x']);
    // A skip of a key K4 never collected is stale.
    const unused = at({ K3: { operated: ['a › k', 's › x'] } });
    expect(ids(unused, skip)).toEqual(['keyboard-skip-unused K4 s › x']);
  });

  it('a skip restricted to some engines applies and is checked only there', () => {
    const skip = { ...NO_SKIP, K4: ['s › x', 's › y'] };
    const only = { K4: { 's › x': [P] } };
    const at = (project: string, o: Partial<Record<KeyboardPart, Partial<PartCoverage>>>) =>
      covered().map((p) => ({ ...p, project, ...o[p.part] }));
    const k3 = { operated: ['a › k', 's › x', 's › y'] };
    // On a listed engine the restricted skip is a skip like any: used here, so no finding.
    expect(ids(at(P, { K3: k3, K4: { collected: ['s › x', 's › y'] } }), skip, only)).toEqual([]);
    // On a listed engine where K4 no longer collects it, it is stale.
    expect(ids(at(P, { K3: k3, K4: { collected: ['s › y'] } }), skip, only)).toEqual([
      'keyboard-skip-unused K4 s › x',
    ]);
    // On another engine it is no skip at all: not reported unused, nor unbacked.
    expect(
      ids(
        at('q', { K4: { collected: ['s › y'] }, K3: { operated: ['a › k', 's › y'] } }),
        skip,
        only,
        'q',
      ),
    ).toEqual([]);
    // An unrestricted key is still checked on every engine.
    expect(ids(at('q', { K3: k3 }), skip, only, 'q')).toEqual(['keyboard-skip-unused K4 s › y']);
    expect(drainSkip('K4', P, skip, only)).toEqual(['s › x', 's › y']);
    expect(drainSkip('K4', 'q', skip, only)).toEqual(['s › y']);
    // The real lists: every restricted key is a skip of its part, on known engines.
    for (const [id, keys] of Object.entries(DRAIN_SKIP_ONLY) as [
      KeyboardPart,
      Record<string, readonly string[]>,
    ][]) {
      for (const [key, engines] of Object.entries(keys)) {
        expect(DRAIN_SKIP[id], key).toContain(key);
        for (const e of engines) expect(['chromium', 'firefox', 'webkit']).toContain(e);
      }
    }
  });

  it('the kbd-c split: K7 runs right after K4 (#130 plan §3.5)', () => {
    expect(KEYBOARD_PARTS).toEqual(['K1', 'K2', 'K3', 'K4', 'K5', 'K7']);
    expect(SINGLE_TEST_ORDER).toEqual(['K1', 'K3', 'K4', 'K7', 'K2', 'K5']);
    expect(partOfTitle('K7 toolbar, edit layout (L25, L26)')).toBe('K7');
    expect(partOfTitle('K4 b-3 and b-2 view tools (L24 b-3 b-2)')).toBe('K4');
    expect(partOfTitle('K8 x')).toBeUndefined();
  });

  it('routeOf matches the route table', () => {
    expect(routeOf('/t/acme/board/x1', '')).toBe('/t/:tenant/board/:uid');
    expect(routeOf('/t/acme/boards', '')).toBe('/t/:tenant/boards');
    expect(routeOf('/t/acme/nope', 'Page not found')).toBe('/t/:tenant/*');
    expect(routeOf('/nope', 'Page not found')).toBe('not-found');
    expect(routeOf('/', 'Pulsus Dash could not load your session')).toBe('session-error');
    expect(routeOf('/signed-out', '')).toBe('/signed-out');
  });

  it('drainPending leaves out operated and done keys', () => {
    expect(drainPending(['a', 'b', 'c'], 's', new Set(['s › a']), new Set(['s › b']))).toEqual([
      'c',
    ]);
  });

  it('stableRead retries until the state holds', async () => {
    /** A fake page: each read and each state check takes the next of its states. */
    const fake = (reads: (string | Error)[], nows: string[]) => {
      let r = 0;
      let n = 0;
      const read = vi.fn(() => {
        const s = reads[r] ?? 'end';
        r += 1;
        return s instanceof Error
          ? Promise.reject(s)
          : Promise.resolve({ state: s, value: `${s} #${String(r)}` });
      });
      const now = vi.fn(() => {
        const s = nows[n] ?? 'end';
        n += 1;
        return Promise.resolve(s);
      });
      const between = vi.fn(() => Promise.resolve());
      return { read, now, between };
    };
    // (a) stable at once.
    const a = fake(['s'], ['s']);
    expect(await stableRead(a.read, a.now, 3, a.between)).toEqual({ state: 's', value: 's #1' });
    expect(a.read).toHaveBeenCalledTimes(1);
    // (b) a dialog opens during the first read: the second read is the dialog's.
    const b = fake(['none', 'dialog "E"'], ['dialog "E"', 'dialog "E"']);
    expect(await stableRead(b.read, b.now, 3, b.between)).toEqual({
      state: 'dialog "E"',
      value: 'dialog "E" #2',
    });
    expect(b.between).toHaveBeenCalledTimes(1);
    // (c) never stable: undefined after three reads.
    const c = fake(['x', 'x', 'x', 'x'], ['y', 'y', 'y', 'y']);
    expect(await stableRead(c.read, c.now, 3, c.between)).toBeUndefined();
    expect(c.read).toHaveBeenCalledTimes(3);
    // (d) the first read throws (an overlay closed under it); the second is stable.
    const d = fake([new Error('gone'), 's'], ['s', 's']);
    expect(await stableRead(d.read, d.now, 3, d.between)).toEqual({ state: 's', value: 's #2' });
    expect(d.read).toHaveBeenCalledTimes(2);
  });

  it('bad input is exit 2', () => {
    const files = Object.fromEntries(
      backed().map((p) => [coverageFileName(P, p.part), JSON.stringify(p)]),
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
