/**
 * The module-graph rule of `ci:dep-audit` (plan #198 Part 2a §3.6; ADR-0024 §4): no chunk of a
 * browser build holds `minimist` (commonmark's CLI dependency), a Node built-in (also as Vite's
 * `__vite-browser-external` id, the empty stand-in a browser build gets for one) or
 * `parse5-sax-parser`'s `SAXParser` entry, which extends `node:stream`.
 */
import type { Finding } from './report.ts';

export interface ModuleFinding extends Finding {
  rule: 'forbidden-module';
  /** The chunk file, relative to the output directory. */
  chunk: string;
  /** The module id as the bundler recorded it. */
  module: string;
}

export const FORBIDDEN_MODULES: readonly RegExp[] = [
  /\/node_modules\/minimist\//,
  /^\0?node:/,
  /__vite-browser-external/,
  /\/node_modules\/parse5-sax-parser\/dist\/(index|dev-null-stream)\.js$/,
];

/** Shows a module id without its leading NUL (virtual-module marker). */
function shown(id: string): string {
  return id.startsWith('\0') ? `\\0${id.slice(1)}` : id;
}

/** One finding per chunk and forbidden module, in chunk then module order. */
export function forbiddenModules(
  chunks: Readonly<Record<string, readonly string[]>>,
  file = 'modules.json',
): ModuleFinding[] {
  const out: ModuleFinding[] = [];
  for (const chunk of Object.keys(chunks).sort()) {
    for (const module of chunks[chunk] ?? []) {
      if (!FORBIDDEN_MODULES.some((re) => re.test(module))) continue;
      out.push({
        rule: 'forbidden-module',
        file,
        chunk,
        module,
        subject: module,
        message: `chunk ${chunk} holds ${shown(module)}, which must not reach the browser (ADR-0024)`,
      });
    }
  }
  return out;
}

/** Parses a `modules.json` graph: `{chunkFile: moduleId[]}`. */
export function parseGraph(v: unknown): Record<string, string[]> | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const out: Record<string, string[]> = {};
  for (const [k, ids] of Object.entries(v)) {
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string')) return null;
    out[k] = ids;
  }
  return out;
}

/** Stub (tests first): plan #198 Part 3a §3.4. */
export interface ManifestChunk {
  readonly file: string;
  readonly isEntry?: boolean;
  readonly isDynamicEntry?: boolean;
  readonly imports?: readonly string[];
  readonly dynamicImports?: readonly string[];
}
export type Manifest = Readonly<Record<string, ManifestChunk>>;

export function parseManifest(v: unknown): Manifest | null {
  return typeof v === 'object' && v !== null ? (v as Manifest) : null;
}

export function markdownInRoute(
  _manifest: Manifest,
  _chunks: Readonly<Record<string, readonly string[]>>,
): Finding[] {
  return [];
}
