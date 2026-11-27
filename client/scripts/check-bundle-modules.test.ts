/**
 * unit:bundle-modules (plan #198 Part 2a §3.6, §5; ADR-0024 §4): no chunk of a build holds
 * `minimist`, a Node built-in (also as Vite's browser-external id) or `SAXParser`'s entry. Part 3a
 * (§3.4; ADR-0014 §8): no Markdown module is in the static closure of `index.html` or `BoardPage`,
 * and the check fails closed on a manifest it cannot follow.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  forbiddenModules,
  geoInRoute,
  markdownInRoute,
  parseManifest,
} from './lib/bundleModules.ts';

const clientRoot = fileURLToPath(new URL('..', import.meta.url));
const fixtures = fileURLToPath(new URL('./__fixtures__/bundle-modules/', import.meta.url));

function graph(name: string): Record<string, string[]> {
  return JSON.parse(readFileSync(`${fixtures}${name}/modules.json`, 'utf8')) as Record<
    string,
    string[]
  >;
}

function manifest(name: string) {
  const m = parseManifest(
    JSON.parse(readFileSync(`${fixtures}${name}/.vite/manifest.json`, 'utf8')) as unknown,
  );
  if (m === null) throw new Error(`${name}: not a manifest`);
  return m;
}

/** The CLI on fixture builds: each name is an output directory under the fixtures. */
function cli(...dirs: string[]): { status: number | null; stderr: string } {
  const r = spawnSync(
    process.execPath,
    ['scripts/check-bundle-modules.ts', '--cache', fixtures, ...dirs.map((d) => `${fixtures}${d}`)],
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

const MARKDOWN_BAD: [string, string, Record<string, string>][] = [
  [
    'markdown-in-route',
    'markdown-in-route',
    { chunk: 'assets/shared-s2.js', module: '/repo/client/node_modules/commonmark/lib/index.js' },
  ],
  ['no-route-root', 'missing-route-root', { subject: 'src/pages/board/BoardPage.tsx' }],
  ['bad-import', 'bad-manifest-import', { subject: '_gone.js' }],
  ['unmapped-chunk', 'unmapped-chunk', { chunk: 'assets/BoardPage-b1.js' }],
  ['no-markdown-entry', 'missing-markdown-entry', { subject: 'src/widgets/text/TextMarkdown.tsx' }],
  [
    'markdown-entry-static',
    'missing-markdown-entry',
    { subject: 'src/widgets/text/TextMarkdown.tsx' },
  ],
  [
    'markdown-entry-empty',
    'missing-markdown-entry',
    { chunk: 'assets/TextMarkdown-m1.js', subject: 'src/widgets/text/TextMarkdown.tsx' },
  ],
];

describe('unit:bundle-modules (Markdown in the route, plan #198 Part 3a §3.4)', () => {
  it('Markdown reached only through dynamic imports → no finding, exit 0', () => {
    expect(markdownInRoute(manifest('markdown-lazy'), graph('markdown-lazy'))).toEqual([]);
    expect(markdownInRoute(manifest('clean'), graph('clean'))).toEqual([]);
    expect(cli('markdown-lazy').status).toBe(0);
  });

  for (const [name, rule, at] of MARKDOWN_BAD) {
    it(`${name} → exactly one ${rule}, exit 1`, () => {
      const f = markdownInRoute(manifest(name), graph(name));
      expect(f).toHaveLength(1);
      expect(f[0]).toMatchObject({ rule, ...at });
      const r = cli(name);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`error[${rule}]`);
    });
  }

  it('a build without a manifest → exit 2', () => {
    const r = cli('no-manifest');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('manifest');
  });
});

describe('unit:bundle-modules (geo in the route, plan #234 Part 3 §4.8)', () => {
  it('clean: the geo host and scene are dynamic entries, targets and the model in the board route → none', () => {
    expect(geoInRoute(manifest('clean'), graph('clean'))).toEqual([]);
    expect(geoInRoute(manifest('markdown-lazy'), graph('markdown-lazy'))).toEqual([]);
    expect(geoInRoute(manifest('geo-targets-in-board'), graph('geo-targets-in-board'))).toEqual([]);
    expect(cli('clean').status).toBe(0);
    expect(cli('geo-targets-in-board').status).toBe(0);
  });

  const GEO_BAD: [string, string, Record<string, string>][] = [
    [
      'geo-in-index',
      'geo-in-route',
      { chunk: 'assets/index-a1.js', module: '/repo/client/src/vis/geo/frame.ts' },
    ],
    [
      'geo-frame-in-board',
      'geo-in-route',
      { chunk: 'assets/ChartFrame-c1.js', module: '/repo/client/src/vis/geo/frame.ts' },
    ],
    [
      'geo-targets-in-list',
      'geo-in-route',
      { chunk: 'assets/BoardsPage-l1.js', module: '/repo/client/src/vis/geo/targets.ts' },
    ],
    ['geo-entry-static', 'missing-geo-entry', { subject: 'src/charts/GeoMapFrame.tsx' }],
  ];
  for (const [name, rule, at] of GEO_BAD) {
    it(`${name} → exactly one ${rule}, exit 1`, () => {
      const f = geoInRoute(manifest(name), graph(name));
      expect(f).toHaveLength(1);
      expect(f[0]).toMatchObject({ rule, ...at });
      const r = cli(name);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`error[${rule}]`);
    });
  }

  it('fails closed: a missing root or an unmapped chunk is a finding', () => {
    expect(geoInRoute(manifest('no-route-root'), graph('no-route-root'))).toEqual(
      expect.arrayContaining([expect.objectContaining({ rule: 'missing-route-root' })]),
    );
    expect(geoInRoute(manifest('unmapped-chunk'), graph('unmapped-chunk'))).toEqual(
      expect.arrayContaining([expect.objectContaining({ rule: 'unmapped-chunk' })]),
    );
  });
});
