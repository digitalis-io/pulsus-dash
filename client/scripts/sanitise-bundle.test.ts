/**
 * unit:sanitise-bundle (plan #198 Part 2a §3.6, §5; ADR-0024, ADR-0014 §8): a Vite build of a probe
 * that lazily imports the sanitiser modules, the Markdown renderer included (Part 2b). The lazy chunk holds the ADR-0024 packages, no
 * forbidden module (minimist, a Node built-in, `SAXParser`), and is at most 100 000 bytes after
 * brotli 11. A second build of a module that extends `node:stream`'s `Transform` (as `SAXParser`
 * does) must be caught.
 */
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants } from 'node:zlib';
import { build, type Rolldown } from 'vite';
import { describe, expect, it } from 'vitest';
import viteConfig from '../vite.config.ts';
import { forbiddenModules } from './lib/bundleModules.ts';

const clientRoot = fileURLToPath(new URL('..', import.meta.url));
const probe = fileURLToPath(new URL('./__fixtures__/sanitise-probe/', import.meta.url));

/** The probe limit (plan §3.6); the route lazy-chunk budget is 120 000. */
const PROBE_LIMIT = 100_000;

async function chunks(input: string): Promise<Rolldown.OutputChunk[]> {
  const out = await build({
    configFile: false,
    root: clientRoot,
    logLevel: 'silent',
    resolve: { alias: viteConfig.resolve?.alias ?? [] },
    build: {
      write: false,
      minify: true,
      modulePreload: { polyfill: false },
      rolldownOptions: { input, external: [/^react(?:-dom)?(?:\/|$)/] },
    },
  });
  const results = Array.isArray(out) ? out : [out];
  return results.flatMap((r) =>
    'output' in r ? r.output.filter((o): o is Rolldown.OutputChunk => o.type === 'chunk') : [],
  );
}

function graphOf(cs: readonly Rolldown.OutputChunk[]): Record<string, string[]> {
  return Object.fromEntries(cs.map((c) => [c.fileName, c.moduleIds]));
}

describe('unit:sanitise-bundle', () => {
  it('the lazy sanitiser chunk holds the packages, no forbidden module, ≤ 100 000 bytes', async () => {
    const cs = await chunks(`${probe}entry.ts`);
    expect(forbiddenModules(graphOf(cs))).toEqual([]);
    const lazy = cs.filter((c) => !c.isEntry);
    expect(lazy).toHaveLength(1);
    const [chunk] = lazy;
    if (chunk === undefined) return;
    const ids = chunk.moduleIds.join('\n');
    for (const m of [
      '/node_modules/commonmark/',
      '/node_modules/parse5/dist/',
      '/node_modules/parse5-sax-parser/dist/parser-feedback-simulator.js',
      '/src/security/sanitise/findIframes.ts',
      '/src/security/sanitise/markdown.tsx',
      '/src/kit/Icon.tsx',
    ]) {
      expect(ids, m).toContain(m);
    }
    const size = brotliCompressSync(Buffer.from(chunk.code), {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    }).length;
    console.info(
      `unit:sanitise-bundle: lazy chunk ${chunk.fileName} ${String(size)} bytes (brotli 11)`,
    );
    expect(size).toBeLessThanOrEqual(PROBE_LIMIT);
  }, 120_000);

  it('a module that extends node:stream Transform yields a forbidden-module finding', async () => {
    const cs = await chunks(`${probe}node-builtin.ts`);
    const f = forbiddenModules(graphOf(cs));
    expect(f.length).toBeGreaterThanOrEqual(1);
    expect(f.map((x) => x.module).join('\n')).toMatch(/__vite-browser-external|node:stream/);
  }, 120_000);
});
