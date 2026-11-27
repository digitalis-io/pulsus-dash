/**
 * The module-graph rules of `ci:dep-audit` (plan #198 Part 2a §3.6; ADR-0024 §4): no chunk of a
 * browser build holds `minimist` (commonmark's CLI dependency), a Node built-in (also as Vite's
 * `__vite-browser-external` id, the empty stand-in a browser build gets for one) or
 * `parse5-sax-parser`'s `SAXParser` entry, which extends `node:stream`. Part 3a (§3.4; ADR-0014
 * §8): no Markdown module is in the static closure of `index.html` or the board route, and the
 * Markdown entry is its own lazy chunk (`markdownInRoute`). Plan #234 Part 3 (§4.8): no geomap
 * module is in the initial closure, the board route holds only the geo targets and the Inspector's
 * geo model, and the host and the scene are dynamic entries (`geoInRoute`).
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

/** A Vite manifest entry: the fields the Markdown rules follow. */
export interface ManifestChunk {
  readonly file: string;
  readonly isEntry?: boolean;
  readonly isDynamicEntry?: boolean;
  readonly imports?: readonly string[];
  readonly dynamicImports?: readonly string[];
}
/** `<outDir>/.vite/manifest.json`: source key → its chunk. */
export type Manifest = Readonly<Record<string, ManifestChunk>>;

/**
 * The Markdown code (plan #198 Part 3a §3.4; ADR-0014 §8): its packages, the renderer and iframe
 * scanner, and the Text widget's dynamic entry. None may be in the board route's static closure.
 */
export const MARKDOWN_MODULES: readonly RegExp[] = [
  /\/node_modules\/(commonmark|parse5|parse5-sax-parser|entities|mdurl)\//,
  /\/src\/security\/sanitise\/(markdown\.tsx|findIframes\.ts)$/,
  /\/src\/widgets\/text\/TextMarkdown\.tsx$/,
];
/** The roots whose static closure (manifest `imports`, not `dynamicImports`) is checked. */
export const ROUTE_ROOTS = ['index.html', 'src/pages/board/BoardPage.tsx'] as const;
/** The Text widget's dynamic entry: the one chunk the renderer belongs in. */
export const MARKDOWN_ENTRY = 'src/widgets/text/TextMarkdown.tsx';
const RENDERER = /\/src\/security\/sanitise\/markdown\.tsx$/;

export type MarkdownRule =
  | 'markdown-in-route'
  | 'missing-route-root'
  | 'bad-manifest-import'
  | 'unmapped-chunk'
  | 'missing-markdown-entry';

export interface MarkdownFinding extends Finding {
  rule: MarkdownRule;
  /** The chunk file, when the finding is about one. */
  chunk?: string;
  /** The module id, for `markdown-in-route`. */
  module?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStrings(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** Parses a Vite manifest; null when any entry lacks a `file` or has a malformed field. */
export function parseManifest(v: unknown): Manifest | null {
  if (!isRecord(v)) return null;
  const out: Record<string, ManifestChunk> = {};
  for (const [key, c] of Object.entries(v)) {
    if (!isRecord(c) || typeof c['file'] !== 'string') return null;
    const { imports, dynamicImports, isEntry, isDynamicEntry } = c;
    if (imports !== undefined && !isStrings(imports)) return null;
    if (dynamicImports !== undefined && !isStrings(dynamicImports)) return null;
    if (isEntry !== undefined && typeof isEntry !== 'boolean') return null;
    if (isDynamicEntry !== undefined && typeof isDynamicEntry !== 'boolean') return null;
    out[key] = {
      file: c['file'],
      ...(isEntry === undefined ? {} : { isEntry }),
      ...(isDynamicEntry === undefined ? {} : { isDynamicEntry }),
      ...(imports === undefined ? {} : { imports }),
      ...(dynamicImports === undefined ? {} : { dynamicImports }),
    };
  }
  return out;
}

/**
 * The Markdown rules (plan #198 Part 3a §3.4), fail-closed: for each root, its static closure
 * through manifest `imports` holds no `MARKDOWN_MODULES` id (`markdown-in-route`); a root that is
 * absent (`missing-route-root`), an import key the manifest lacks (`bad-manifest-import`) or a
 * closure chunk without a module list (`unmapped-chunk`) is a finding, never a pass. The Markdown
 * entry must be present, a dynamic entry, and hold the renderer (`missing-markdown-entry`).
 * Each finding is reported once, in root then walk order.
 */
export function markdownInRoute(
  manifest: Manifest,
  chunks: Readonly<Record<string, readonly string[]>>,
  file = 'manifest.json',
): MarkdownFinding[] {
  const out: MarkdownFinding[] = [];
  const seen = new Set<string>();
  const once = (key: string, f: MarkdownFinding): void => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push(f);
  };
  for (const root of ROUTE_ROOTS) {
    if (manifest[root] === undefined) {
      once(`root:${root}`, {
        rule: 'missing-route-root',
        file,
        subject: root,
        message: `the manifest has no ${root}: the route's closure cannot be checked`,
      });
      continue;
    }
    const visited = new Set<string>();
    const stack: string[] = [root];
    while (stack.length > 0) {
      const key = stack.pop() ?? '';
      if (visited.has(key)) continue;
      visited.add(key);
      const c = manifest[key];
      if (c === undefined) {
        once(`import:${key}`, {
          rule: 'bad-manifest-import',
          file,
          subject: key,
          message: `${key} is imported but absent from the manifest: the closure cannot be followed`,
        });
        continue;
      }
      const ids = chunks[c.file];
      if (ids === undefined) {
        once(`unmapped:${c.file}`, {
          rule: 'unmapped-chunk',
          file,
          chunk: c.file,
          subject: c.file,
          message: `chunk ${c.file} (of ${key}) has no module list in modules.json`,
        });
      } else {
        for (const module of ids) {
          if (!MARKDOWN_MODULES.some((re) => re.test(module))) continue;
          once(`md:${c.file}:${module}`, {
            rule: 'markdown-in-route',
            file,
            chunk: c.file,
            module,
            subject: module,
            message: `chunk ${c.file} holds ${shown(module)} in the static closure of ${root}: Markdown loads only with ${MARKDOWN_ENTRY} (ADR-0014 §8)`,
          });
        }
      }
      for (const i of [...(c.imports ?? [])].reverse()) stack.push(i);
    }
  }
  const entry = manifest[MARKDOWN_ENTRY];
  const entryIds = entry === undefined ? undefined : chunks[entry.file];
  const problem =
    entry === undefined
      ? 'is absent from the manifest'
      : entry.isDynamicEntry !== true
        ? 'is not a dynamic entry'
        : !(entryIds ?? []).some((id) => RENDERER.test(id))
          ? `has a chunk (${entry.file}) without the renderer`
          : null;
  if (problem !== null) {
    out.push({
      rule: 'missing-markdown-entry',
      file,
      subject: MARKDOWN_ENTRY,
      ...(entry === undefined ? {} : { chunk: entry.file }),
      message: `${MARKDOWN_ENTRY} ${problem}`,
    });
  }
  return out;
}

/**
 * The geomap code (plan #234 Part 3 §4.8; ADR-0014 §8): the geo data, the engine's geo controller
 * and painter, the host's parts, the host and the Inspector's geo model.
 */
export const GEO_MODULES: readonly RegExp[] = [
  /\/src\/vis\/geo\//,
  /\/src\/engine\/(canvas2d|controller)\/geo\//,
  /\/src\/charts\/geo\//,
  /\/src\/charts\/GeoMapFrame\.tsx$/,
  /\/src\/inspector\/geoModel\.ts$/,
];
/** What the board route may hold of it: the targets and the model the shared Inspector needs. */
export const GEO_BOARD_ALLOWED: readonly RegExp[] = [
  /\/src\/vis\/geo\/targets\.ts$/,
  /\/src\/inspector\/geoModel\.ts$/,
];
/** The strict roots (nothing geo) and the board route (the allowed modules only). */
export const GEO_ROOTS: readonly { root: string; allowed: readonly RegExp[] }[] = [
  { root: 'index.html', allowed: [] },
  { root: 'src/pages/boards/BoardsPage.tsx', allowed: [] },
  { root: 'src/pages/board/BoardPage.tsx', allowed: GEO_BOARD_ALLOWED },
];
/** The geo dynamic entries: the host and the engine's scene. */
export const GEO_ENTRIES = [
  'src/charts/GeoMapFrame.tsx',
  'src/engine/canvas2d/geo/scene.ts',
] as const;

export type GeoRule =
  | 'geo-in-route'
  | 'missing-route-root'
  | 'bad-manifest-import'
  | 'unmapped-chunk'
  | 'missing-geo-entry';

export interface GeoFinding extends Finding {
  rule: GeoRule;
  chunk?: string;
  module?: string;
}

/**
 * The geo rule (plan #234 Part 3 §4.8), fail-closed like `markdownInRoute`: no `GEO_MODULES` id in
 * the static closure of `index.html` or the boards list; the board route only the targets and the
 * Inspector's model; a missing root, an unknown import or an unmapped chunk is a finding; each
 * `GEO_ENTRIES` module present and a dynamic entry (`missing-geo-entry`). Each finding once, in
 * root then walk order.
 */
export function geoInRoute(
  manifest: Manifest,
  chunks: Readonly<Record<string, readonly string[]>>,
  file = 'manifest.json',
): GeoFinding[] {
  const out: GeoFinding[] = [];
  const seen = new Set<string>();
  const once = (key: string, f: GeoFinding): void => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push(f);
  };
  for (const { root, allowed } of GEO_ROOTS) {
    if (manifest[root] === undefined) {
      once(`root:${root}`, {
        rule: 'missing-route-root',
        file,
        subject: root,
        message: `the manifest has no ${root}: the route's closure cannot be checked`,
      });
      continue;
    }
    const visited = new Set<string>();
    const stack: string[] = [root];
    while (stack.length > 0) {
      const key = stack.pop() ?? '';
      if (visited.has(key)) continue;
      visited.add(key);
      const c = manifest[key];
      if (c === undefined) {
        once(`import:${key}`, {
          rule: 'bad-manifest-import',
          file,
          subject: key,
          message: `${key} is imported but absent from the manifest: the closure cannot be followed`,
        });
        continue;
      }
      const ids = chunks[c.file];
      if (ids === undefined) {
        once(`unmapped:${c.file}`, {
          rule: 'unmapped-chunk',
          file,
          chunk: c.file,
          subject: c.file,
          message: `chunk ${c.file} (of ${key}) has no module list in modules.json`,
        });
      } else {
        for (const module of ids) {
          if (!GEO_MODULES.some((re) => re.test(module))) continue;
          if (allowed.some((re) => re.test(module))) continue;
          once(`geo:${c.file}:${module}`, {
            rule: 'geo-in-route',
            file,
            chunk: c.file,
            module,
            subject: module,
            message: `chunk ${c.file} holds ${shown(module)} in the static closure of ${root}: the geomap loads only with its dynamic entries (ADR-0014 §8)`,
          });
        }
      }
      for (const i of [...(c.imports ?? [])].reverse()) stack.push(i);
    }
  }
  for (const entry of GEO_ENTRIES) {
    const c = manifest[entry];
    const problem =
      c === undefined
        ? 'is absent from the manifest'
        : c.isDynamicEntry !== true
          ? 'is not a dynamic entry'
          : null;
    if (problem === null) continue;
    out.push({
      rule: 'missing-geo-entry',
      file,
      subject: entry,
      ...(c === undefined ? {} : { chunk: c.file }),
      message: `${entry} ${problem}`,
    });
  }
  return out;
}
