import { afterEach, describe, expect, it, vi } from 'vitest';

const RENDER = '/assets/dash-engine-render-a.js';
const POOL = '/assets/dash-engine-pool-b.js';

vi.mock('./workerUrls', () => ({ RENDER_URL: RENDER, POOL_URL: POOL }));

interface Rules {
  createScriptURL(u: string): string;
}

async function load(): Promise<typeof import('./workers')> {
  vi.resetModules();
  return import('./workers');
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'trustedTypes');
});

describe('the pulsus-engine Trusted Types policy (ADR-0026)', () => {
  it('admits only the two engine worker URLs', async () => {
    const created: { name: string; rules: Rules }[] = [];
    Object.defineProperty(globalThis, 'trustedTypes', {
      configurable: true,
      value: {
        createPolicy: (name: string, rules: Rules) => {
          created.push({ name, rules });
          return { createScriptURL: (u: string) => rules.createScriptURL(u) };
        },
      },
    });
    const w = await load();
    expect(String(w.scriptUrl(RENDER))).toBe(RENDER);
    expect(String(w.scriptUrl(POOL))).toBe(POOL);
    expect(created.map((c) => c.name)).toEqual(['pulsus-engine']);
    const rules = created[0]?.rules;
    if (rules === undefined) throw new Error('no policy');
    const other = new URL(RENDER, location.href);
    other.port = String(Number(location.port || '80') + 1);
    for (const bad of ['blob:x', other.href, '/assets/other.js']) {
      expect(() => rules.createScriptURL(bad), bad).toThrow();
    }
    // The same URL in absolute form is the same script.
    expect(rules.createScriptURL(new URL(POOL, location.href).href)).toBe(
      new URL(POOL, location.href).href,
    );
    // One policy per page.
    w.scriptUrl(RENDER);
    expect(created).toHaveLength(1);
  });

  it('without Trusted Types the URL is a plain string', async () => {
    const w = await load();
    expect(w.scriptUrl(RENDER)).toBe(RENDER);
  });
});
