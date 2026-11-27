/**
 * `unit:material-fallback` (#282, VL-017 as amended): the materials (header, popover, tooltip,
 * Inspector) are opaque `surface-1` in their base rule; the translucent material and its backdrop
 * filter apply inside `@supports (backdrop-filter…)` only, with no positive preference query, so a
 * browser without the reduced-transparency query (Safari, Firefox) still gets it; a later
 * `@media (prefers-reduced-transparency: reduce), (forced-colors: active)` rule sets the opaque
 * `surface-1` back with no filter.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss, { type AtRule, type Container, type Declaration, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

const CLIENT_ROOT = fileURLToPath(new URL('..', import.meta.url));

const MATERIALS: readonly { file: string; cls: string }[] = [
  { file: 'src/shell/Header.module.css', cls: '.header' },
  { file: 'src/kit/Popover.module.css', cls: '.popover' },
  { file: 'src/kit/Tooltip.module.css', cls: '.tooltip' },
  { file: 'src/inspector/Inspector.module.css', cls: '.sheet' },
];

const FILTERS = new Set(['backdrop-filter', '-webkit-backdrop-filter']);

function ancestors(d: Declaration): AtRule[] {
  const out: AtRule[] = [];
  let p: Container | undefined = d.parent;
  while (p !== undefined && p.type !== 'root') {
    if (p.type === 'atrule') out.push(p as AtRule);
    p = p.parent as Container | undefined;
  }
  return out;
}

const isSupports = (a: AtRule): boolean =>
  a.name === 'supports' && a.params.includes('backdrop-filter');
const isOverride = (a: AtRule): boolean =>
  a.name === 'media' &&
  /prefers-reduced-transparency:\s*reduce/.test(a.params) &&
  /forced-colors:\s*active/.test(a.params);

const isMaterialBackground = (d: Declaration): boolean =>
  (d.prop === 'background' || d.prop === 'background-color') && d.value.includes('--material-');

const decls = (r: Rule): Declaration[] =>
  r.nodes.filter((n): n is Declaration => n.type === 'decl');

describe('unit:material-fallback', () => {
  for (const { file, cls } of MATERIALS) {
    it(`${file}: ${cls} is the material where the browser can blur, opaque otherwise`, () => {
      const root = postcss.parse(readFileSync(join(CLIENT_ROOT, file), 'utf8'), { from: file });
      const base = root.nodes.filter(
        (n): n is Rule => n.type === 'rule' && n.selectors.includes(cls),
      );
      expect(base.length, `${cls} has a top-level rule`).toBeGreaterThan(0);
      const baseDecls = base.flatMap(decls);
      expect(
        baseDecls.filter((d) => d.prop === 'background').map((d) => d.value),
        `${cls} base background`,
      ).toEqual(['var(--surface-1)']);
      expect(baseDecls.filter((d) => FILTERS.has(d.prop)).map((d) => d.prop)).toEqual([]);

      // Every material and blur sits in @supports alone: no media query gates it.
      let lastMaterial = -1;
      root.walkDecls((d) => {
        if (!isMaterialBackground(d) && !(FILTERS.has(d.prop) && d.value !== 'none')) return;
        const at = ancestors(d);
        const where = `${file}:${String(d.source?.start?.line)} ${d.prop}`;
        expect(at.some(isSupports), where).toBe(true);
        expect(
          at.filter((a) => a.name === 'media').map((a) => a.params),
          where,
        ).toEqual([]);
        lastMaterial = Math.max(lastMaterial, d.source?.start?.offset ?? 0);
      });
      expect(lastMaterial, `${file} has the material`).toBeGreaterThan(-1);

      // The override, after the material: opaque surface-1, both filters none.
      const overrides: Rule[] = [];
      root.walkAtRules((a) => {
        if (!isOverride(a)) return;
        a.walkRules((r) => {
          if (r.selectors.includes(cls)) overrides.push(r);
        });
      });
      expect(overrides.length, `${file} overrides for reduce and forced colours`).toBe(1);
      const o = overrides[0];
      if (o === undefined) return;
      expect(o.source?.start?.offset ?? 0).toBeGreaterThan(lastMaterial);
      const od = decls(o);
      expect(od.filter((d) => d.prop === 'background').map((d) => d.value)).toEqual([
        'var(--surface-1)',
      ]);
      expect(
        od
          .filter((d) => FILTERS.has(d.prop))
          .map((d) => `${d.prop}: ${d.value}`)
          .sort(),
      ).toEqual(['-webkit-backdrop-filter: none', 'backdrop-filter: none']);
    });
  }
});
