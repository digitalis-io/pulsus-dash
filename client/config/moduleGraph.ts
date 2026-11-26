/**
 * `dash-module-ids` (plan #198 Part 2a §3.6; review r1): the module graph of a browser build, for
 * `scripts/check-bundle-modules.ts` (`ci:dep-audit`). After the build is written, it records
 * `{chunkFile: moduleIds}` for every chunk of the main bundle **and** of every worker bundle that
 * Vite builds separately (the engine's workers), in
 * `<cacheRoot>/<basename(outDir)>/modules.json`. The file is outside every output directory, so the
 * signed asset set is unchanged, and each output directory has its own file.
 *
 * Use: `main` in `plugins`, `worker()` in `worker.plugins`. Worker bundles are generated before the
 * main bundle is written; their chunk files keep their names when Vite emits them as assets.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Plugin } from 'vite';

export type ModuleGraph = Record<string, string[]>;

export interface ModuleGraphPlugins {
  main: Plugin;
  worker: () => Plugin;
}

export function moduleGraphPlugins(
  cacheRoot: string,
  onGraph?: (outDir: string, graph: ModuleGraph) => void,
): ModuleGraphPlugins {
  let workers: ModuleGraph = {};
  const main: Plugin = {
    name: 'dash-module-ids',
    apply: 'build',
    buildStart() {
      workers = {};
    },
    writeBundle(options, bundle) {
      const graph: ModuleGraph = {};
      for (const [file, out] of Object.entries(bundle)) {
        if (out.type === 'chunk') graph[file] = [...out.moduleIds];
      }
      for (const [file, ids] of Object.entries(workers)) graph[file] = ids;
      const outDir = basename(options.dir ?? 'dist');
      const dir = join(cacheRoot, outDir);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'modules.json'), `${JSON.stringify(graph, null, 1)}\n`);
      onGraph?.(outDir, graph);
    },
  };
  const worker = (): Plugin => ({
    name: 'dash-module-ids-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      for (const [file, out] of Object.entries(bundle)) {
        if (out.type === 'chunk') workers[file] = [...out.moduleIds];
      }
    },
  });
  return { main, worker };
}
