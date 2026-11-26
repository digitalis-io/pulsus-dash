/**
 * unit:engine-spec-split (plan #263 §5): every spec that needs an engine tier (`e2e/engine.ts`
 * `tierOf`/`leg`) is listed for the engine suite, and the main suite's pattern ignores exactly the
 * engine-only ones.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ENGINE_ONLY_SPECS, ENGINE_SHARED_SPECS, engineOnlyPattern } from './engineSpecs.ts';

const E2E = new URL('../e2e/', import.meta.url);

describe('unit:engine-spec-split', () => {
  it('(a) the pattern matches each engine-only file name, and only those', () => {
    for (const f of ENGINE_ONLY_SPECS) {
      expect(engineOnlyPattern.test(f), f).toBe(true);
      expect(engineOnlyPattern.test(`e2e/${f}`), `e2e/${f}`).toBe(true);
      expect(engineOnlyPattern.test(`/w/client/e2e/${f}`), f).toBe(true);
      expect(engineOnlyPattern.test(`C:\\w\\client\\e2e\\${f}`), f).toBe(true);
    }
    for (const f of ['csp-violations.spec.ts', 'engine-pin.spec.ts', 'xengine-layer.spec.ts']) {
      expect(engineOnlyPattern.test(f), f).toBe(false);
      expect(engineOnlyPattern.test(`e2e/${f}`), f).toBe(false);
    }
  });

  it('(b) every spec calling tierOf or leg is listed; every listed spec exists', () => {
    const listed = new Set<string>([...ENGINE_ONLY_SPECS, ...ENGINE_SHARED_SPECS]);
    const specs = readdirSync(E2E).filter((f) => f.endsWith('.spec.ts'));
    const engine = specs.filter((f) =>
      /\b(?:tierOf|leg)\(/.test(readFileSync(new URL(f, E2E), 'utf8')),
    );
    expect(engine.length).toBeGreaterThan(0);
    expect(engine.filter((f) => !listed.has(f))).toEqual([]);
    expect([...listed].filter((f) => !existsSync(new URL(f, E2E)))).toEqual([]);
  });
});
