/**
 * unit:bundle-modules (workers; plan #198 Part 2a §3.6, review r1): `dash-module-ids` records the
 * chunks of the separately built worker bundles too, so `check-bundle-modules.ts` sees a forbidden
 * module that only a worker holds.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';
import { forbiddenModules } from '../scripts/lib/bundleModules.ts';
import { moduleGraphPlugins, type ModuleGraph } from './moduleGraph.ts';

const clientRoot = fileURLToPath(new URL('..', import.meta.url));
const probe = fileURLToPath(new URL('../scripts/__fixtures__/worker-probe/', import.meta.url));
const scratch = join(clientRoot, 'node_modules', '.cache', 'dash-test', 'module-graph');

describe('unit:bundle-modules (workers)', () => {
  it('a forbidden module held only by a worker is in the graph and found', async () => {
    rmSync(scratch, { recursive: true, force: true });
    const seen: ModuleGraph[] = [];
    const graphs = moduleGraphPlugins(join(scratch, 'cache'), (_dir, g) => seen.push(g));
    await build({
      configFile: false,
      root: clientRoot,
      logLevel: 'silent',
      plugins: [graphs.main],
      worker: { format: 'es', plugins: () => [graphs.worker()] },
      build: {
        outDir: join(scratch, 'worker-probe'),
        emptyOutDir: true,
        minify: false,
        modulePreload: { polyfill: false },
        rolldownOptions: { input: `${probe}entry.ts` },
      },
    });
    const file = join(scratch, 'cache', 'worker-probe', 'modules.json');
    expect(existsSync(file)).toBe(true);
    const graph = JSON.parse(readFileSync(file, 'utf8')) as ModuleGraph;
    expect(seen).toEqual([graph]);
    const workerChunks = Object.keys(graph).filter((k) =>
      (graph[k] ?? []).some((id) => id.endsWith('/worker-probe/worker.ts')),
    );
    expect(workerChunks).toHaveLength(1);
    const [workerChunk] = workerChunks;
    // The worker file named in the graph is the one written to the output directory.
    expect(existsSync(join(scratch, 'worker-probe', workerChunk ?? ''))).toBe(true);
    const findings = forbiddenModules(graph);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings.every((f) => f.chunk === workerChunk)).toBe(true);
    rmSync(scratch, { recursive: true, force: true });
  }, 120_000);
});
