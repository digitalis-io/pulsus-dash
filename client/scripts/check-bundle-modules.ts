/**
 * `ci:dep-audit (module graph)` (plan #198 Part 2a §3.6; ADR-0024 §4): for each named output
 * directory, reads the module graph that the `dash-module-ids` Vite plugin wrote for it,
 * `node_modules/.cache/dash-build/<basename(outDir)>/modules.json`, and fails on any chunk that holds
 * `minimist`, a Node built-in or `SAXParser` (`scripts/lib/bundleModules.ts`). Then (plan #198
 * Part 3a §3.4) it reads `<outDir>/.vite/manifest.json` and applies the Markdown rules: no Markdown
 * module in the static closure of `index.html` or the board route, and the Markdown entry its own
 * dynamic chunk; a closure it cannot follow is a finding.
 *
 * Usage: node scripts/check-bundle-modules.ts [--cache <dir>] <outDir>…
 * Exit: 0 no findings, 1 findings, 2 a graph or manifest is missing or unreadable (the build was not
 * made).
 */
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  forbiddenModules,
  markdownInRoute,
  parseGraph,
  parseManifest,
  type MarkdownFinding,
  type ModuleFinding,
} from './lib/bundleModules.ts';
import { InputError, readJson, runCli } from './lib/report.ts';

const CLIENT_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const DEFAULT_CACHE = join(CLIENT_ROOT, 'node_modules', '.cache', 'dash-build');

export function checkBundleModules(
  cache: string,
  outDirs: readonly string[],
): (ModuleFinding | MarkdownFinding)[] {
  if (outDirs.length === 0) throw new InputError('name at least one output directory');
  const out: (ModuleFinding | MarkdownFinding)[] = [];
  for (const dir of outDirs) {
    const name = basename(dir);
    const file = join(cache, name, 'modules.json');
    const graph = parseGraph(readJson(file));
    if (graph === null) throw new InputError(`${file} is not a {chunk: moduleIds} graph`);
    out.push(...forbiddenModules(graph, `${name}/modules.json`));
    const manifestFile = join(dir, '.vite', 'manifest.json');
    const manifest = parseManifest(readJson(manifestFile));
    if (manifest === null) throw new InputError(`${manifestFile} is not a Vite manifest`);
    out.push(...markdownInRoute(manifest, graph, `${name}/.vite/manifest.json`));
  }
  return out;
}

if (import.meta.main) {
  await runCli(() => {
    const args = process.argv.slice(2);
    let cache = DEFAULT_CACHE;
    const i = args.indexOf('--cache');
    if (i >= 0) {
      cache = args[i + 1] ?? '';
      args.splice(i, 2);
    }
    return checkBundleModules(cache, args);
  });
}
