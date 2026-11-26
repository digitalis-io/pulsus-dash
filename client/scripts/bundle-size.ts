/**
 * `ci:bundle-size` (PRF-033, ADR-0014 §8): brotli (quality 11) sizes of `dist/` per chunk class
 * against `bundle-budgets.json` (1 KB = 1 000 bytes), after checking that every required M-UI1
 * artefact exists, so a build that drops a route, the CSS or a font cannot pass by being smaller.
 * The engine (PRF-009, plan #68 C1) is one row: every `assets/dash-engine-*` file (its wasm, glue,
 * adapter and workers), required, lazy (never in the initial JS) and outside `totalExceptEngine`.
 * With `required.geoAssets` (plan #231 §3.3) the geo basemap and gazetteer are each exactly one
 * `assets/{basemap,gazetteer}-<hash>.json` and one row (`geo-basemap`, `geo-gazetteer`) inside the
 * total; the `geo-assets` entry chunk that names them is a lazy chunk.
 *
 * Usage: node scripts/bundle-size.ts [dist] [budgets]
 * Exit: 0 no findings, 1 findings, 2 `dist/` or its manifest unreadable.
 */
import { brotliCompressSync, constants } from 'node:zlib';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, record, report, type Finding } from './lib/report.ts';

const CLIENT_ROOT = fileURLToPath(new URL('..', import.meta.url));

export interface Budgets {
  initialRouteModules: string[];
  required: {
    files: string[];
    lazyModules: string[];
    fonts: string[];
    initialCss: boolean;
    geoAssets: boolean;
  };
  budgets: Record<BudgetClass, number>;
  editorModules: string[];
}

export type BudgetClass =
  | 'initialJs'
  | 'initialCss'
  | 'lazyChunk'
  | 'editorChunk'
  | 'fonts'
  | 'totalExceptEngine'
  | 'engine'
  | 'geoBasemap'
  | 'geoGazetteer';

interface ManifestChunk {
  file: string;
  isEntry?: boolean;
  isDynamicEntry?: boolean;
  imports?: string[];
  css?: string[];
  assets?: string[];
}

export interface SizeRow {
  cls: BudgetClass;
  file: string;
  bytes: number;
  budget: number;
}

export function brotliSize(buf: Buffer): number {
  return brotliCompressSync(buf, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
    },
  }).length;
}

function listFiles(dir: string, root = dir, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) listFiles(p, root, out);
    else out.push(relative(root, p).split(sep).join('/'));
  }
  return out;
}

function parseManifest(v: unknown): Map<string, ManifestChunk> {
  const m = new Map<string, ManifestChunk>();
  for (const [key, value] of Object.entries(record(v, 'manifest'))) {
    const c = record(value, `manifest["${key}"]`);
    if (typeof c['file'] !== 'string') continue;
    const list = (x: unknown): string[] =>
      Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : [];
    m.set(key, {
      file: c['file'],
      isEntry: c['isEntry'] === true,
      isDynamicEntry: c['isDynamicEntry'] === true,
      imports: list(c['imports']),
      css: list(c['css']),
      assets: list(c['assets']),
    });
  }
  return m;
}

export function parseBudgets(v: unknown): Budgets {
  const b = record(v, 'bundle-budgets.json');
  const req = record(b['required'], 'required');
  const strs = (x: unknown): string[] =>
    Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : [];
  const budgets = record(b['budgets'], 'budgets');
  const num = (k: BudgetClass): number => (typeof budgets[k] === 'number' ? budgets[k] : 0);
  return {
    initialRouteModules: strs(b['initialRouteModules']),
    required: {
      files: strs(req['files']),
      lazyModules: strs(req['lazyModules']),
      fonts: strs(req['fonts']),
      initialCss: req['initialCss'] === true,
      geoAssets: req['geoAssets'] === true,
    },
    budgets: {
      initialJs: num('initialJs'),
      initialCss: num('initialCss'),
      lazyChunk: num('lazyChunk'),
      editorChunk: num('editorChunk'),
      fonts: num('fonts'),
      totalExceptEngine: num('totalExceptEngine'),
      engine: num('engine'),
      geoBasemap: num('geoBasemap'),
      geoGazetteer: num('geoGazetteer'),
    },
    editorModules: strs(b['editorModules']),
  };
}

function missing(what: string, message: string): Finding {
  return { rule: `missing-artefact:${what}`, file: 'dist', subject: what, message };
}

/** The file name of every chunk holding an editor module (`vite.config.ts` `chunkFileNames`). */
const EDITOR_FILE = /^assets\/editor-[^/]+\.js$/;

/** Every engine file (`vite.config.ts`: chunks, workers and the wasm are `dash-engine-*`). */
const ENGINE_FILE = /^assets\/dash-engine-[^/]+\.(js|wasm)$/;

/** The geo assets (`src/vis/geo/urls.ts`, plan #231 §3.3): class, file pattern, row and name. */
const GEO_ASSETS = [
  ['geoBasemap', /^assets\/basemap-[A-Za-z0-9_-]+\.json$/, 'geo-basemap', 'geo basemap'],
  ['geoGazetteer', /^assets\/gazetteer-[A-Za-z0-9_-]+\.json$/, 'geo-gazetteer', 'geo gazetteer'],
] as const;

/**
 * The editor closure (plan #63 Part C §3.6): the files of the `editorModules` entries and every
 * `assets/editor-*.js` file reachable from them through static manifest `imports`. The walk goes
 * only through `editor-*` files: any other import (the entry, a shared chunk, the route chunk) is
 * neither counted nor walked through, and keeps its own initial or lazy row.
 */
export function editorClosure(
  manifest: ReadonlyMap<string, ManifestChunk>,
  entries: readonly string[],
): Set<string> {
  const files = new Set<string>();
  const keys = new Set<string>();
  const walk = (key: string, entry: boolean): void => {
    if (keys.has(key)) return;
    const c = manifest.get(key);
    if (c === undefined || (!entry && !EDITOR_FILE.test(c.file))) return;
    keys.add(key);
    files.add(c.file);
    for (const i of c.imports ?? []) walk(i, false);
  };
  for (const e of entries) walk(e, true);
  return files;
}

export interface BundleResult {
  findings: Finding[];
  rows: SizeRow[];
  /** 2 when dist/ or the manifest is unreadable. */
  exitCode: 0 | 1 | 2;
}

export function checkBundle(dist: string, budgetsJson: unknown): BundleResult {
  const budgets = parseBudgets(budgetsJson);
  const findings: Finding[] = [];
  const rows: SizeRow[] = [];

  const manifestPath = join(dist, '.vite', 'manifest.json');
  if (!existsSync(dist) || !statSync(dist).isDirectory()) {
    return {
      findings: [missing('dist', 'dist/ does not exist: run npm run build')],
      rows,
      exitCode: 2,
    };
  }
  if (!existsSync(manifestPath)) {
    return {
      findings: [missing('.vite/manifest.json', 'the Vite manifest is missing (build.manifest)')],
      rows,
      exitCode: 2,
    };
  }
  let manifest: Map<string, ManifestChunk>;
  try {
    manifest = parseManifest(readJson(manifestPath));
  } catch {
    return {
      findings: [missing('.vite/manifest.json', 'the Vite manifest does not parse')],
      rows,
      exitCode: 2,
    };
  }

  // Required artefacts.
  for (const f of budgets.required.files) {
    if (!existsSync(join(dist, f))) findings.push(missing(f, `${f} is missing from dist/`));
  }
  const entry = manifest.get('index.html');
  if (entry?.isEntry !== true)
    findings.push(missing('index.html', 'no manifest entry index.html with isEntry'));
  for (const m of budgets.initialRouteModules) {
    if (!manifest.has(m)) findings.push(missing(m, `no manifest entry for ${m}`));
  }
  for (const m of budgets.required.lazyModules) {
    if (manifest.get(m)?.isDynamicEntry !== true) {
      findings.push(missing(m, `no dynamic-entry manifest entry for ${m}`));
    }
  }

  // Initial set: entry + its static imports + each initial route module and its static imports.
  const initial = new Set<string>();
  const visit = (key: string): void => {
    if (initial.has(key)) return;
    const c = manifest.get(key);
    if (c === undefined) return;
    initial.add(key);
    for (const i of c.imports ?? []) visit(i);
  };
  if (entry !== undefined) visit('index.html');
  for (const m of budgets.initialRouteModules) visit(m);
  const initialCss = new Set<string>();
  for (const k of initial) for (const css of manifest.get(k)?.css ?? []) initialCss.add(css);
  if (budgets.required.initialCss && initialCss.size === 0) {
    findings.push(missing('initial-css', 'the initial chunks reference no CSS file'));
  }

  const allFiles = listFiles(dist).filter((f) => !f.startsWith('.vite/'));
  const fileSet = new Set(allFiles);
  for (const stem of budgets.required.fonts) {
    const re = new RegExp(
      `^assets/${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-[A-Za-z0-9_-]+\\.woff2$`,
    );
    const n = allFiles.filter((f) => re.test(f)).length;
    if (n !== 1)
      findings.push(
        missing(`font ${stem}`, `expected exactly one ${stem} font, found ${String(n)}`),
      );
  }

  const named = new Set<string>();
  for (const c of manifest.values()) {
    named.add(c.file);
    for (const x of c.css ?? []) named.add(x);
    for (const x of c.assets ?? []) named.add(x);
  }
  for (const f of [...named].sort()) {
    if (!fileSet.has(f))
      findings.push(missing(f, `${f} is named in the manifest but missing on disk`));
  }

  // Budgets.
  const sizes = new Map<string, number>();
  const size = (f: string): number => {
    let s = sizes.get(f);
    if (s === undefined) {
      s = fileSet.has(f) ? brotliSize(readFileSync(join(dist, f))) : 0;
      sizes.set(f, s);
    }
    return s;
  };
  const over = (cls: BudgetClass, file: string, bytes: number): void => {
    const budget = budgets.budgets[cls];
    rows.push({ cls, file, bytes, budget });
    if (bytes > budget) {
      findings.push({
        rule: `over-budget:${cls}`,
        file,
        subject: cls,
        message: `${String(bytes)} bytes brotli, budget ${String(budget)}`,
      });
    }
  };

  const initialJsFiles = [...initial]
    .map((k) => manifest.get(k)?.file ?? '')
    .filter((f) => f !== '');
  over(
    'initialJs',
    'initial JS',
    [...new Set(initialJsFiles)].reduce((a, f) => a + size(f), 0),
  );
  over(
    'initialCss',
    'initial CSS',
    [...initialCss].reduce((a, f) => a + size(f), 0),
  );
  const initialFileSet = new Set(initialJsFiles);
  const editor = editorClosure(manifest, budgets.editorModules);
  for (const f of [...editor].sort()) {
    if (initialFileSet.has(f)) {
      findings.push({
        rule: 'editor-in-initial',
        file: f,
        subject: 'editorChunk',
        message: `${f} is in the initial JS`,
      });
    }
  }
  if (editor.size > 0) {
    over(
      'editorChunk',
      `editor closure (${String(editor.size)} files)`,
      [...editor].reduce((a, f) => a + size(f), 0),
    );
  }
  for (const f of allFiles.filter((x) => EDITOR_FILE.test(x) && !editor.has(x)).sort()) {
    findings.push({
      rule: 'editor-orphan',
      file: f,
      subject: 'editorChunk',
      message: `${f} is named as editor code but no editor entry reaches it`,
    });
  }
  const engine = allFiles.filter((f) => ENGINE_FILE.test(f)).sort();
  if (!engine.some((f) => f.endsWith('.wasm'))) {
    findings.push(
      missing('engine', 'no assets/dash-engine-*.wasm: build the engine (make engine-wasm)'),
    );
  }
  for (const f of engine.filter((x) => initialFileSet.has(x))) {
    findings.push({
      rule: 'engine-in-initial',
      file: f,
      subject: 'engine',
      message: `${f} is in the initial JS; the engine loads on the first chart frame`,
    });
  }
  const engineSet = new Set(engine);
  if (engine.length > 0) {
    over(
      'engine',
      `engine (${String(engine.length)} files)`,
      engine.reduce((a, f) => a + size(f), 0),
    );
  }
  if (budgets.required.geoAssets) {
    for (const [cls, re, row, what] of GEO_ASSETS) {
      const files = allFiles.filter((f) => re.test(f));
      const [file] = files;
      if (files.length !== 1 || file === undefined) {
        findings.push(
          missing(what, `expected exactly one ${what} asset, found ${String(files.length)}`),
        );
      } else {
        over(cls, row, size(file));
      }
    }
  }
  const seen = new Set<string>();
  for (const c of manifest.values()) {
    const f = c.file;
    if (
      !f.endsWith('.js') ||
      initialFileSet.has(f) ||
      editor.has(f) ||
      engineSet.has(f) ||
      seen.has(f)
    )
      continue;
    seen.add(f);
    over('lazyChunk', f, size(f));
  }
  const fonts = allFiles.filter((f) => f.startsWith('assets/') && f.endsWith('.woff2'));
  over(
    'fonts',
    'fonts',
    fonts.reduce((a, f) => a + size(f), 0),
  );
  over(
    'totalExceptEngine',
    'total',
    allFiles.filter((f) => !engineSet.has(f)).reduce((a, f) => a + size(f), 0),
  );

  return { findings, rows, exitCode: findings.length > 0 ? 1 : 0 };
}

export function main(argv: readonly string[]): number {
  const dist = argv[0] ?? join(CLIENT_ROOT, 'dist');
  let budgets: unknown;
  try {
    budgets = readJson(argv[1] ?? join(CLIENT_ROOT, 'bundle-budgets.json'));
  } catch (e) {
    console.error(`error[input] ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  const r = checkBundle(dist, budgets);
  for (const row of r.rows) {
    console.log(`${row.cls}, ${row.file}, ${String(row.bytes)}, ${String(row.budget)}`);
  }
  const code = report(r.findings);
  return r.exitCode === 2 ? 2 : code;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
