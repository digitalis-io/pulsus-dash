/**
 * `ci:geo-data` (T24-087; plan #231 §5): the committed geo assets match `tools/geo/manifest.json`
 * and decode; a changed byte, an asset that does not decode and a missing manifest fail.
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkGeoData, main } from './check-geo-data.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BASEMAP = 'client/src/vis/geo/data/basemap.json';
const GAZETTEER = 'client/src/vis/geo/data/gazetteer.json';
const MANIFEST = 'tools/geo/manifest.json';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A copy of the repository's geo assets and manifest under a fresh root. */
function copyRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'geo-data-'));
  dirs.push(root);
  for (const f of [BASEMAP, GAZETTEER, MANIFEST]) {
    expect(existsSync(join(ROOT, f)), f).toBe(true);
    cpSync(join(ROOT, f), join(root, f));
  }
  return root;
}

const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => undefined);

describe('ci:geo-data (T24-087)', () => {
  it('the committed files pass', () => {
    expect(checkGeoData(ROOT)).toStrictEqual([]);
    expect(main([ROOT])).toBe(0);
  });
  it('a changed byte → sha256-mismatch naming the asset', () => {
    const root = copyRoot();
    const p = join(root, GAZETTEER);
    const b = readFileSync(p);
    b[b.length - 2] = 0x20;
    writeFileSync(p, b);
    const f = checkGeoData(root);
    expect(f.map((x) => [x.rule, x.file])).toStrictEqual([['sha256-mismatch', GAZETTEER]]);
    quiet();
    expect(main([root])).toBe(1);
  });
  it('a non-decoding asset with a matching digest → invalid-asset', () => {
    const root = copyRoot();
    const bad = Buffer.from('{"v":1,"q":100,"countries":[],"coast":[],"border":[],"x":1}\n');
    writeFileSync(join(root, BASEMAP), bad);
    const m = JSON.parse(readFileSync(join(root, MANIFEST), 'utf8')) as {
      assets: { file: string; sha256: string; bytes: number }[];
    };
    for (const a of m.assets) {
      if (a.file === BASEMAP) {
        a.sha256 = createHash('sha256').update(bad).digest('hex');
        a.bytes = bad.length;
      }
    }
    writeFileSync(join(root, MANIFEST), JSON.stringify(m));
    const f = checkGeoData(root);
    expect(f.map((x) => [x.rule, x.file])).toStrictEqual([['invalid-asset', BASEMAP]]);
    quiet();
    expect(main([root])).toBe(1);
  });
  it('a missing manifest → exit 2', () => {
    const root = copyRoot();
    rmSync(join(root, MANIFEST));
    quiet();
    expect(main([root])).toBe(2);
  });
});
