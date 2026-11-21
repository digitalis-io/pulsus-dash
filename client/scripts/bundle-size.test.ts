import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { checkBundle } from './bundle-size.ts';

const budgets: unknown = JSON.parse(
  readFileSync(fileURLToPath(new URL('../bundle-budgets.json', import.meta.url)), 'utf8'),
);

/** Seeded pseudo-random bytes (mulberry32): incompressible, so brotli size ≈ length. */
function randomBytes(n: number, seed = 57): Buffer {
  const b = Buffer.alloc(n);
  let a = seed;
  for (let i = 0; i < n; i++) {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    b[i] = ((t ^ (t >>> 14)) >>> 0) & 0xff;
  }
  return b;
}

const LAZY = [
  ['src/pages/board/BoardPage.tsx', 'assets/BoardPage-x.js'],
  ['src/pages/explore/MetricsPage.tsx', 'assets/MetricsPage-x.js'],
  ['src/pages/explore/LogsPage.tsx', 'assets/LogsPage-x.js'],
  ['src/pages/admin/AdminPage.tsx', 'assets/AdminPage-x.js'],
  ['src/pages/SignedOutPage.tsx', 'assets/SignedOutPage-x.js'],
  ['src/shell/TimeRangeDialog.tsx', 'assets/TimeRangeDialog-x.js'],
  ['src/pages/board/BoardGridEditor.tsx', 'assets/BoardGridEditor-x.js'],
] as const;

interface Overrides {
  files?: Record<string, Buffer | null>;
  dropKeys?: string[];
  entryCss?: string[];
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A complete, small M-UI1 dist/; overrides replace or delete files and manifest keys. */
function makeDist(o: Overrides = {}): string {
  const dist = mkdtempSync(join(tmpdir(), 'bundle-size-'));
  dirs.push(dist);
  const manifest: Record<string, unknown> = {
    'index.html': {
      file: 'assets/index-x.js',
      src: 'index.html',
      isEntry: true,
      imports: ['_shared-x.js'],
      dynamicImports: ['src/pages/boards/BoardsPage.tsx', ...LAZY.map(([k]) => k)],
      css: o.entryCss ?? ['assets/index-x.css'],
      assets: [
        'assets/inter-latin-wght-normal-x.woff2',
        'assets/jetbrains-mono-latin-wght-normal-x.woff2',
      ],
    },
    '_shared-x.js': { file: 'assets/shared-x.js' },
    'src/pages/boards/BoardsPage.tsx': {
      file: 'assets/BoardsPage-x.js',
      isDynamicEntry: true,
      imports: ['_shared-x.js'],
    },
    ...Object.fromEntries(
      LAZY.map(([k, f]) => [k, { file: f, isDynamicEntry: true, imports: ['_shared-x.js'] }]),
    ),
  };
  for (const k of o.dropKeys ?? []) Reflect.deleteProperty(manifest, k);
  const files: Record<string, Buffer | null> = {
    'index.html': Buffer.from(
      '<!doctype html><script type="module" src="/assets/index-x.js"></script>',
    ),
    '.vite/manifest.json': Buffer.from(JSON.stringify(manifest)),
    'assets/index-x.js': Buffer.from('console.log(1)'),
    'assets/shared-x.js': Buffer.from('export const s = 1'),
    'assets/BoardsPage-x.js': Buffer.from('export const b = 1'),
    'assets/index-x.css': Buffer.from('body{margin:0}'),
    'assets/inter-latin-wght-normal-x.woff2': Buffer.from('font-a'),
    'assets/jetbrains-mono-latin-wght-normal-x.woff2': Buffer.from('font-b'),
    ...Object.fromEntries(LAZY.map(([, f]) => [f, Buffer.from('export default 1')])),
    ...o.files,
  };
  for (const [path, content] of Object.entries(files)) {
    if (content === null) continue;
    mkdirSync(dirname(join(dist, path)), { recursive: true });
    writeFileSync(join(dist, path), content);
  }
  return dist;
}

const rules = (dist: string): string[] => checkBundle(dist, budgets).findings.map((f) => f.rule);

describe('bundle-size budgets (T05-002)', () => {
  it('(a) an initial JS entry over 200 KB', () => {
    expect(rules(makeDist({ files: { 'assets/index-x.js': randomBytes(250_000) } }))).toEqual([
      'over-budget:initialJs',
    ]);
  });
  it('(b) a lazy chunk over 120 KB', () => {
    expect(rules(makeDist({ files: { 'assets/BoardPage-x.js': randomBytes(130_000) } }))).toEqual([
      'over-budget:lazyChunk',
    ]);
  });
  it('(c) the complete small dist passes', () => {
    const r = checkBundle(makeDist(), budgets);
    expect(r.findings).toEqual([]);
    expect(r.exitCode).toBe(0);
  });
});

describe('bundle-size required artefacts (T05-002)', () => {
  it('(d) no manifest → exit 2', () => {
    const r = checkBundle(makeDist({ files: { '.vite/manifest.json': null } }), budgets);
    expect(r.exitCode).toBe(2);
    expect(r.findings.map((f) => f.rule)).toEqual(['missing-artefact:.vite/manifest.json']);
  });
  it.each([
    ['(e)', { files: { 'index.html': null } }, 'missing-artefact:index.html'],
    [
      '(f)',
      { dropKeys: ['src/pages/boards/BoardsPage.tsx'] },
      'missing-artefact:src/pages/boards/BoardsPage.tsx',
    ],
    [
      '(g)',
      { dropKeys: ['src/shell/TimeRangeDialog.tsx'] },
      'missing-artefact:src/shell/TimeRangeDialog.tsx',
    ],
    ['(h)', { entryCss: [] }, 'missing-artefact:initial-css'],
    [
      '(i)',
      { files: { 'assets/inter-latin-wght-normal-x.woff2': null } },
      'missing-artefact:font inter-latin-wght-normal',
    ],
    [
      '(j)',
      { files: { 'assets/jetbrains-mono-latin-wght-normal-y.woff2': Buffer.from('dup') } },
      'missing-artefact:font jetbrains-mono-latin-wght-normal',
    ],
    ['(k)', { files: { 'assets/BoardPage-x.js': null } }, 'missing-artefact:assets/BoardPage-x.js'],
  ] as [string, Overrides, string][])('%s → %s', (_case, overrides, rule) => {
    const r = checkBundle(makeDist(overrides), budgets);
    expect(r.findings.map((f) => f.rule)).toContain(rule);
    expect(r.exitCode).toBe(1);
  });
});
