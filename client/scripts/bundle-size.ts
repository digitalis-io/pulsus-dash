/**
 * `ci:bundle-size` (PRF-033, ADR-0014 §8): brotli (quality 11) sizes of `dist/` per chunk class
 * against `bundle-budgets.json` (1 KB = 1 000 bytes), after checking that every required M-UI1
 * artefact exists, so a build that drops a route, the CSS or a font cannot pass by being smaller.
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
  required: { files: string[]; lazyModules: string[]; fonts: string[]; initialCss: boolean };
  budgets: Record<BudgetClass, number>;
  editorModules: string[];
}

export type BudgetClass =
  'initialJs' | 'initialCss' | 'lazyChunk' | 'editorChunk' | 'fonts' | 'totalExceptEngine';

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
    },
    budgets: {
      initialJs: num('initialJs'),
      initialCss: num('initialCss'),
      lazyChunk: num('lazyChunk'),
      editorChunk: num('editorChunk'),
      fonts: num('fonts'),
      totalExceptEngine: num('totalExceptEngine'),
    },
    editorModules: strs(b['editorModules']),
  };
}

function missing(what: string, message: string): Finding {
  return { rule: `missing-artefact:${what}`, file: 'dist', subject: what, message };
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
  const editor = new Set(budgets.editorModules);
  const initialFileSet = new Set(initialJsFiles);
  const seen = new Set<string>();
  for (const [key, c] of manifest) {
    if (!c.file.endsWith('.js') || initialFileSet.has(c.file) || seen.has(c.file)) continue;
    seen.add(c.file);
    over(editor.has(key) ? 'editorChunk' : 'lazyChunk', c.file, size(c.file));
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
    allFiles.reduce((a, f) => a + size(f), 0),
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
