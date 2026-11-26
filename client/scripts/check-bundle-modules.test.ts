/**
 * unit:bundle-modules (plan #198 Part 2a §3.6, §5; ADR-0024 §4): no chunk of a build holds
 * `minimist`, a Node built-in (also as Vite's browser-external id) or `SAXParser`'s entry.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { forbiddenModules } from './lib/bundleModules.ts';

const clientRoot = fileURLToPath(new URL('..', import.meta.url));
const fixtures = fileURLToPath(new URL('./__fixtures__/bundle-modules/', import.meta.url));

function graph(name: string): Record<string, string[]> {
  return JSON.parse(readFileSync(`${fixtures}${name}/modules.json`, 'utf8')) as Record<
    string,
    string[]
  >;
}

function cli(...dirs: string[]): { status: number | null; stderr: string } {
  const r = spawnSync(
    process.execPath,
    ['scripts/check-bundle-modules.ts', '--cache', fixtures, ...dirs],
    { cwd: clientRoot, encoding: 'utf8' },
  );
  return { status: r.status, stderr: r.stderr };
}

const BAD: [string, string, string][] = [
  ['minimist', 'assets/text-c3.js', '/repo/client/node_modules/minimist/index.js'],
  ['node-stream', 'assets/index-a1.js', 'node:stream'],
  ['nul-node', 'assets/text-c3.js', '\0node:stream'],
  ['browser-external', 'assets/index-a1.js', '__vite-browser-external:node:stream'],
  ['browser-external-nul', 'assets/text-c3.js', '\0__vite-browser-external:node:stream'],
  ['sax-index', 'assets/text-c3.js', '/repo/client/node_modules/parse5-sax-parser/dist/index.js'],
  // A worker chunk of the engine (review r1): the main bundle is clean.
  [
    'worker',
    'assets/dash-engine-render.worker-d4.js',
    '\0__vite-browser-external:node:worker_threads',
  ],
];

describe('unit:bundle-modules', () => {
  it('clean → no finding and exit 0; a missing graph → exit 2', () => {
    expect(forbiddenModules(graph('clean'))).toEqual([]);
    expect(cli('clean').status).toBe(0);
    const missing = cli('clean', 'no-such-build');
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('no-such-build');
  });

  for (const [name, chunk, module] of BAD) {
    it(`${name} → one forbidden-module naming the chunk and module, exit 1`, () => {
      const f = forbiddenModules(graph(name));
      expect(f).toHaveLength(1);
      expect(f[0]).toMatchObject({ rule: 'forbidden-module', chunk, module });
      const r = cli(name);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('error[forbidden-module]');
      expect(r.stderr).toContain(chunk);
    });
  }

  it('checks every named build: one bad build fails the run', () => {
    expect(cli('clean', 'minimist').status).toBe(1);
  });
});
