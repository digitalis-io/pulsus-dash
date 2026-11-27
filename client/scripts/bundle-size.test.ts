import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { checkBundle, main, NEAR_BUDGET_BYTES } from './bundle-size.ts';

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
  ['src/pages/explore/MetricsPage.tsx', 'assets/MetricsPage-r.js'],
  ['src/pages/explore/LogsPage.tsx', 'assets/LogsPage-x.js'],
  ['src/pages/admin/AdminPage.tsx', 'assets/AdminPage-x.js'],
  ['src/pages/SignedOutPage.tsx', 'assets/SignedOutPage-x.js'],
  ['src/shell/TimeRangeDialog.tsx', 'assets/TimeRangeDialog-x.js'],
  ['src/pages/board/BoardGrid.tsx', 'assets/BoardGrid-x.js'],
  ['src/widgets/text/TextMarkdown.tsx', 'assets/TextMarkdown-x.js'],
] as const;

interface Overrides {
  files?: Record<string, Buffer | null>;
  dropKeys?: string[];
  entryCss?: string[];
  /** Extra static imports of the entry `index.html`. */
  entryImports?: string[];
  /** Extra manifest entries. */
  manifest?: Record<string, unknown>;
}

/**
 * The editor entries E1, E2 and their shared chunk S (plan #63 Part C §5 (h)–(k)), the LogQL
 * language entry E3 (plan #66 Part A §3.11) and the Logs page's editor entry E4 (Part C).
 */
const E1 = 'assets/editor-e1.js';
const E2 = 'assets/editor-e2.js';
const E3 = 'assets/editor-e3.js';
const E4 = 'assets/editor-e4.js';
const S = 'assets/editor-s.js';
const R = 'assets/MetricsPage-r.js';
/** The engine per mode (plan #68 C2d2 §3.4): wasm and worker (with its glue) of MT and ST. */
const ENGINE_WASM = 'assets/dash-engine-mt-a.wasm';
const ENGINE_WORKER = 'assets/dash-engine-mt-render.worker-a.js';
const ST_WASM = 'assets/dash-engine-st-b.wasm';
const ST_WORKER = 'assets/dash-engine-st-render-st.worker-b.js';
/** The geo assets (plan #231 §3.3) and the `geo-assets` entry that names them. */
const GEO_BASEMAP = 'assets/basemap-a1.json';
const GEO_GAZETTEER = 'assets/gazetteer-b2.json';
const GEO_ENTRY = 'assets/geo-assets-c3.js';

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
      imports: ['_shared-x.js', ...(o.entryImports ?? [])],
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
    'src/editor/editor.ts': { file: E1, isDynamicEntry: true, imports: [] },
    'src/editor/lang/promql/promql.ts': {
      file: E2,
      isDynamicEntry: true,
      imports: ['_editor-s.js', 'src/pages/explore/MetricsPage.tsx'],
    },
    'src/editor/lang/logql/logql.ts': { file: E3, isDynamicEntry: true, imports: ['_editor-s.js'] },
    'src/editor/logqlEditor.ts': { file: E4, isDynamicEntry: true, imports: ['_editor-s.js'] },
    '_editor-s.js': { file: S, imports: ['index.html'] },
    'src/vis/geo/urls.ts': {
      file: GEO_ENTRY,
      src: 'src/vis/geo/urls.ts',
      isEntry: true,
      assets: [GEO_BASEMAP, GEO_GAZETTEER],
    },
  };
  const metrics = manifest['src/pages/explore/MetricsPage.tsx'] as
    Record<string, unknown> | undefined;
  if (metrics !== undefined) {
    metrics['dynamicImports'] = [
      'src/editor/editor.ts',
      'src/editor/lang/promql/promql.ts',
      'src/editor/lang/logql/logql.ts',
    ];
  }
  const logs = manifest['src/pages/explore/LogsPage.tsx'] as Record<string, unknown> | undefined;
  if (logs !== undefined) {
    logs['dynamicImports'] = ['src/editor/lang/logql/logql.ts', 'src/editor/logqlEditor.ts'];
  }
  Object.assign(manifest, o.manifest ?? {});
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
    [E1]: Buffer.from('export const e1 = 1'),
    [E2]: Buffer.from('export const e2 = 1'),
    [E3]: Buffer.from('export const e3 = 1'),
    [E4]: Buffer.from('export const e4 = 1'),
    [S]: Buffer.from('export const s = 1'),
    // The engine (plan #68 C1): its wasm and a worker entry.
    [ENGINE_WASM]: Buffer.from('wasm'),
    [ENGINE_WORKER]: Buffer.from('export {}'),
    [ST_WASM]: Buffer.from('wasm-st'),
    [ST_WORKER]: Buffer.from('export {s}'),
    [GEO_BASEMAP]: Buffer.from('{"v":1}'),
    [GEO_GAZETTEER]: Buffer.from('{"v":1}'),
    [GEO_ENTRY]: Buffer.from('const a="/assets/basemap-a1.json";export{a}'),
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
    [
      '(l)',
      { dropKeys: ['src/editor/logqlEditor.ts'] },
      'missing-artefact:src/editor/logqlEditor.ts',
    ],
  ] as [string, Overrides, string][])('%s → %s', (_case, overrides, rule) => {
    const r = checkBundle(makeDist(overrides), budgets);
    expect(r.findings.map((f) => f.rule)).toContain(rule);
    expect(r.exitCode).toBe(1);
  });
});

describe('bundle-size editor closure (PRF-009)', () => {
  const big = {
    [E1]: randomBytes(100_000, 1),
    [E2]: randomBytes(60_000, 2),
    [S]: randomBytes(20_000, 3),
    [R]: randomBytes(30_000, 4),
  };
  it('(h) the editor-* closure is one row; the route chunk keeps its own', () => {
    const r = checkBundle(makeDist({ files: big }), budgets);
    expect(r.findings.map((f) => f.rule)).toEqual(['over-budget:editorChunk']);
    const editor = r.rows.filter((x) => x.cls === 'editorChunk');
    expect(editor).toHaveLength(1);
    expect(editor[0]?.file).toBe('editor closure (5 files)');
    expect(editor[0]?.bytes).toBeGreaterThan(180_000);
    expect(r.rows.some((x) => x.cls === 'lazyChunk' && x.file === S)).toBe(false);
    const route = r.rows.find((x) => x.cls === 'lazyChunk' && x.file === R);
    expect(route?.bytes).toBeGreaterThan(30_000);
    expect(route?.bytes).toBeLessThan(31_000);
  });
  it('(i) a smaller shared chunk passes', () => {
    const r = checkBundle(makeDist({ files: { ...big, [S]: randomBytes(10_000, 3) } }), budgets);
    expect(r.findings).toEqual([]);
  });
  it('(j) an editor entry in the initial JS', () => {
    // `src/editor/editor.ts` is also a required lazy module (plan #263 `lazy-in-initial`).
    expect(rules(makeDist({ entryImports: ['src/editor/editor.ts'] }))).toEqual([
      'lazy-in-initial',
      'editor-in-initial',
    ]);
  });
  it('(k) an editor-* file outside the closure', () => {
    expect(rules(makeDist({ files: { 'assets/editor-x.js': Buffer.from('x') } }))).toEqual([
      'editor-orphan',
    ]);
  });
});

describe('bundle-size engine rows per mode (PRF-009, plan #68 C1, C2d2 §3.4)', () => {
  const SHARED = 'assets/dash-engine-c.js';
  /** A lazy shared adapter chunk (in both closures). */
  const shared = (b: Buffer): Overrides => ({
    manifest: { 'src/engine/wasm/engine.ts': { file: SHARED, isDynamicEntry: true } },
    files: { [SHARED]: b },
  });
  const rowsOf = (r: ReturnType<typeof checkBundle>, cls: string) =>
    r.rows.filter((row) => (row.cls as string) === cls);

  it('engine-mt and engine-st each count their files and the shared chunk, outside the total', async () => {
    const { brotliSize } = await import('./bundle-size.ts');
    const wasm = randomBytes(1_000_000, 3);
    const stWasm = randomBytes(900_000, 5);
    const worker = Buffer.from('export const w = 1;'.repeat(50));
    const big = randomBytes(300_000, 6);
    const o = shared(big);
    const r = checkBundle(
      makeDist({
        ...o,
        files: { ...o.files, [ENGINE_WASM]: wasm, [ENGINE_WORKER]: worker, [ST_WASM]: stWasm },
      }),
      budgets,
    );
    expect(r.findings).toEqual([]);
    expect(r.exitCode).toBe(0);
    const mt = rowsOf(r, 'engineMt');
    const st = rowsOf(r, 'engineSt');
    expect([mt.length, st.length]).toEqual([1, 1]);
    expect(mt[0]?.bytes).toBe(brotliSize(wasm) + brotliSize(worker) + brotliSize(big));
    expect(st[0]?.bytes).toBe(
      brotliSize(stWasm) + brotliSize(Buffer.from('export {s}')) + brotliSize(big),
    );
    expect([mt[0]?.budget, st[0]?.budget]).toEqual([1_900_000, 1_900_000]);
    // PRF-009 per mode: initial JS + initial CSS + that mode's row.
    const core = rowsOf(r, 'core');
    expect(core.map((c) => c.file)).toEqual(['core mt', 'core st']);
    const init = (rowsOf(r, 'initialJs')[0]?.bytes ?? 0) + (rowsOf(r, 'initialCss')[0]?.bytes ?? 0);
    expect(core.map((c) => c.bytes)).toEqual([init + (mt[0]?.bytes ?? 0), init + (st[0]?.bytes ?? 0)]);
    expect(core[0]?.budget).toBe(2_999_999);
    expect(rowsOf(r, 'engine')).toEqual([]);
    const total = r.rows.find((row) => row.cls === 'totalExceptEngine');
    expect(total?.bytes).toBeLessThan(100_000);
    expect(r.rows.some((row) => row.cls === 'lazyChunk' && row.file.includes('dash-engine'))).toBe(
      false,
    );
  });
  it('an ST closure at 1 900 001 B', async () => {
    const { brotliSize } = await import('./bundle-size.ts');
    // Brotli of incompressible bytes is a little over their length: find the length that
    // compresses to exactly the budget plus one with the worker's bytes.
    const rest = brotliSize(Buffer.from('export {s}'));
    let n = 1_900_001 - rest - 10;
    let b = randomBytes(n, 9);
    for (let i = 0; i < 40 && brotliSize(b) + rest !== 1_900_001; i++) {
      n += 1_900_001 - (brotliSize(b) + rest);
      b = randomBytes(n, 9);
    }
    expect(brotliSize(b) + rest).toBe(1_900_001);
    expect(rules(makeDist({ files: { [ST_WASM]: b } }))).toEqual(['over-budget:engineSt']);
  });
  it('an MT engine over 1.9 MB', () => {
    expect(rules(makeDist({ files: { [ENGINE_WASM]: randomBytes(2_000_000, 4) } }))).toEqual([
      'over-budget:engineMt',
    ]);
  });
  it('a shared chunk counts in both rows', () => {
    // 1 000 KB of ST wasm and 950 KB of MT wasm are each under the limit; a 950 KB shared chunk
    // takes both over.
    const o = shared(randomBytes(950_000, 7));
    expect(
      rules(
        makeDist({
          ...o,
          files: { ...o.files, [ENGINE_WASM]: randomBytes(950_000, 8), [ST_WASM]: randomBytes(1_000_000, 10) },
        }),
      ),
    ).toEqual(['over-budget:engineMt', 'over-budget:engineSt']);
  });
  it('an engine chunk in the initial JS, either mode or shared', () => {
    for (const f of ['assets/dash-engine-c.js', 'assets/dash-engine-st-c.js', 'assets/dash-engine-mt-c.js']) {
      const dist = makeDist({
        entryImports: ['_e.js'],
        manifest: { '_e.js': { file: f } },
        files: { [f]: Buffer.from('export const c = 1') },
      });
      expect(rules(dist), f).toEqual(['engine-in-initial']);
    }
  });
  it.each([
    ['no MT wasm', { [ENGINE_WASM]: null }, 'missing-artefact:engine-mt-wasm'],
    ['no MT glue', { [ENGINE_WORKER]: null }, 'missing-artefact:engine-mt-js'],
    ['no ST wasm', { [ST_WASM]: null }, 'missing-artefact:engine-st-wasm'],
    ['no ST glue', { [ST_WORKER]: null }, 'missing-artefact:engine-st-js'],
  ])('%s', (_name, files, rule) => {
    expect(rules(makeDist({ files }))).toEqual([rule]);
  });
  it('each mode core total against 3 MB', () => {
    // 1.8 MB of ST is under its row but, with a 1.25 MB initial JS, over 3 MB in all (the
    // initial JS and the total fail too: their budgets make 3 MB unreachable otherwise).
    const r = checkBundle(
      makeDist({
        files: { [ST_WASM]: randomBytes(1_800_000, 11), 'assets/index-x.js': randomBytes(1_250_000, 12) },
      }),
      budgets,
    );
    const core = r.findings.filter((f) => f.rule === 'over-budget:core');
    expect(core.map((f) => f.file)).toEqual(['core st']);
  });
});

describe('bundle-size geo assets (plan #231 §3.3, T24-087)', () => {
  it('the geo rows: one basemap and one gazetteer, the entry chunk lazy', () => {
    const r = checkBundle(makeDist(), budgets);
    expect(r.findings).toEqual([]);
    const geo = r.rows.filter(
      (x) => x.cls === ('geoBasemap' as string) || x.cls === ('geoGazetteer' as string),
    );
    expect(geo.map((x) => [x.cls, x.file, x.budget])).toEqual([
      ['geoBasemap', 'geo-basemap', 40_000],
      ['geoGazetteer', 'geo-gazetteer', 104_000],
    ]);
    expect(r.rows.some((x) => x.cls === 'lazyChunk' && x.file === GEO_ENTRY)).toBe(true);
  });
  it('no basemap', () => {
    // The manifest still names the file, so its own missing-artefact finding comes too.
    expect(rules(makeDist({ files: { [GEO_BASEMAP]: null } }))).toContain(
      'missing-artefact:geo basemap',
    );
  });
  it('two basemaps', () => {
    expect(rules(makeDist({ files: { 'assets/basemap-z9.json': Buffer.from('{}') } }))).toEqual([
      'missing-artefact:geo basemap',
    ]);
  });
  it('no gazetteer', () => {
    // The manifest still names the file, so its own missing-artefact finding comes too.
    expect(rules(makeDist({ files: { [GEO_GAZETTEER]: null } }))).toContain(
      'missing-artefact:geo gazetteer',
    );
  });
  it('a gazetteer over 104 000 B brotli', () => {
    const big = randomBytes(104_001, 9);
    expect(rules(makeDist({ files: { [GEO_GAZETTEER]: big } }))).toEqual([
      'over-budget:geoGazetteer',
    ]);
    const r = checkBundle(makeDist({ files: { [GEO_GAZETTEER]: big } }), budgets);
    const row = r.rows.find((x) => x.file === 'geo-gazetteer');
    expect(row?.bytes).toBeGreaterThan(104_000);
    const total = r.rows.find((x) => x.cls === 'totalExceptEngine');
    expect(total?.bytes).toBeGreaterThan(104_000);
  });
  it('a basemap over 40 000 B brotli', () => {
    expect(rules(makeDist({ files: { [GEO_BASEMAP]: randomBytes(40_001, 8) } }))).toEqual([
      'over-budget:geoBasemap',
    ]);
  });
});

describe('ci:bundle-size workflow (#135)', () => {
  it('measures dist-http after the http build', () => {
    const lines = readFileSync(
      new URL('../../.github/workflows/client.yml', import.meta.url),
      'utf8',
    ).split('\n');
    const httpSize = lines.flatMap((l, i) =>
      l === "      - name: 'ci:bundle-size (http build)'" ? [i] : [],
    );
    expect(httpSize).toHaveLength(1);
    const h = httpSize[0] ?? -1;
    expect(lines[h + 1]).toBe('        run: npm run size -- dist-http');
    const httpBuild = lines.findIndex((l) => l.includes('vite build --outDir dist-http'));
    expect(httpBuild).toBeGreaterThanOrEqual(0);
    expect(h).toBeGreaterThan(httpBuild);
    const stubSize = lines.flatMap((l, i) =>
      l === "      - name: 'ci:bundle-size (stub build)'" ? [i] : [],
    );
    expect(stubSize).toHaveLength(1);
    const st = stubSize[0] ?? -1;
    expect(lines[st + 1]).toBe('        run: npm run size');
    expect(st).toBeLessThan(httpBuild);
  });
});

/** `budgets` with the initial JS budget replaced. */
function withInitialBudget(initialJs: number): unknown {
  const b = JSON.parse(JSON.stringify(budgets)) as { budgets: Record<string, number> };
  b.budgets['initialJs'] = initialJs;
  return b;
}

describe('bundle-size near-budget warning (#263)', () => {
  const initialBytes = (): number => {
    const row = checkBundle(makeDist(), budgets).rows.find((r) => r.cls === 'initialJs');
    expect(row).toBeDefined();
    return row?.bytes ?? 0;
  };
  it('(l) less than 3 000 B of headroom is one report-only warning', () => {
    expect(NEAR_BUDGET_BYTES).toBe(3000);
    const dist = makeDist();
    const b = withInitialBudget(initialBytes() + 1000);
    const r = checkBundle(dist, b);
    expect(r.findings.map((f) => [f.rule, f.severity, f.subject])).toEqual([
      ['near-budget:initialJs', 'warning', 'initialJs'],
    ]);
    expect(r.findings[0]?.message).toMatch(/1000 below the budget/);
    expect(r.exitCode).toBe(0);
    const path = join(dist, 'budgets-near.json');
    writeFileSync(path, JSON.stringify(b));
    expect(main([dist, path])).toBe(0);
  });
  it('(m) 3 000 B of headroom: no warning', () => {
    const r = checkBundle(makeDist(), withInitialBudget(initialBytes() + 3000));
    expect(r.findings).toEqual([]);
  });
  it('(n) over the budget: over-budget only', () => {
    const r = checkBundle(makeDist(), withInitialBudget(initialBytes() - 1));
    expect(r.findings.map((f) => f.rule)).toEqual(['over-budget:initialJs']);
    expect(r.exitCode).toBe(1);
  });
});

describe('bundle-size build boundaries (#263, PRF-009, T24-087)', () => {
  it('(o) a lazy module in the initial JS', () => {
    const r = checkBundle(
      makeDist({ entryImports: ['src/widgets/text/TextMarkdown.tsx'] }),
      budgets,
    );
    expect(r.findings.map((f) => [f.rule, f.subject])).toEqual([
      ['lazy-in-initial', 'src/widgets/text/TextMarkdown.tsx'],
    ]);
    expect(r.exitCode).toBe(1);
  });
  const geo = (o: Record<string, unknown>) => ({
    'src/vis/geo/urls.ts': {
      file: GEO_ENTRY,
      src: 'src/vis/geo/urls.ts',
      isEntry: true,
      assets: [GEO_BASEMAP, GEO_GAZETTEER],
      ...o,
    },
  });
  it.each([
    ['imports the index chunk', { manifest: geo({ imports: ['index.html'] }) }],
    [
      'is a shell chunk',
      {
        manifest: geo({ file: 'assets/shell-c3.js' }),
        files: { 'assets/shell-c3.js': Buffer.from('x') },
      },
    ],
    ['is absent', { dropKeys: ['src/vis/geo/urls.ts'] }],
    ['is not an entry', { manifest: geo({ isEntry: false }) }],
    ['is in the initial JS', { entryImports: ['src/vis/geo/urls.ts'] }],
  ] as [string, Overrides][])('(p) the geo-assets entry %s', (_case, overrides) => {
    const r = checkBundle(makeDist(overrides), budgets);
    expect(r.findings.map((f) => f.rule)).toEqual(['geo-entry-merged']);
    expect(r.exitCode).toBe(1);
  });
  it('(p) the unchanged geo-assets entry passes', () => {
    expect(checkBundle(makeDist(), budgets).findings).toEqual([]);
  });
});

describe('make client-check (#263)', () => {
  it('builds both API modes and measures each', () => {
    const lines = readFileSync(new URL('../../Makefile', import.meta.url), 'utf8').split('\n');
    const start = lines.findIndex((l) => /^client-check:/.test(l));
    expect(start, 'no client-check target').toBeGreaterThanOrEqual(0);
    const body: string[] = [];
    for (const l of lines.slice(start + 1)) {
      if (!l.startsWith('\t')) break;
      body.push(l);
    }
    const recipe = body.join('\n');
    let at = -1;
    for (const step of [
      'npm run build',
      'npm run size',
      'vite build --outDir dist-http',
      'npm run size -- dist-http',
      'npm run origins',
    ]) {
      const i = recipe.indexOf(step, at + 1);
      expect(i, `${step} after position ${String(at)}`).toBeGreaterThan(at);
      at = i;
    }
    expect(lines.find((l) => l.startsWith('.PHONY:'))).toMatch(/\bclient-check\b/);
  });
});
