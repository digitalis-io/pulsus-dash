/**
 * `unit:material-fallback` (#282, VL-017 as amended): the materials (header, popover, tooltip,
 * Inspector) are opaque `surface-1` by default; the translucent material and its backdrop filter
 * apply only inside a positive `@supports (backdrop-filter…)` and the reduced-transparency /
 * forced-colours guard, so a browser without the filter, or a user who asked for less
 * transparency or forced colours, gets the opaque surface in both themes.
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

/** Inside `@supports (backdrop-filter…)` and the no-preference, not-forced-colours media guard. */
function guarded(d: Declaration): boolean {
  const at = ancestors(d);
  const supports = at.some((a) => a.name === 'supports' && a.params.includes('backdrop-filter'));
  const media = at.some(
    (a) =>
      a.name === 'media' &&
      /prefers-reduced-transparency:\s*no-preference/.test(a.params) &&
      /not\s*\(forced-colors:\s*active\)/.test(a.params),
  );
  return supports && media;
}

const isMaterialBackground = (d: Declaration): boolean =>
  (d.prop === 'background' || d.prop === 'background-color') && d.value.includes('--material-');

describe('unit:material-fallback', () => {
  for (const { file, cls } of MATERIALS) {
    it(`${file}: ${cls} is opaque surface-1 unless translucency is supported and wanted`, () => {
      const root = postcss.parse(readFileSync(join(CLIENT_ROOT, file), 'utf8'), { from: file });
      const base = root.nodes.filter(
        (n): n is Rule => n.type === 'rule' && n.selectors.includes(cls),
      );
      expect(base.length, `${cls} has a top-level rule`).toBeGreaterThan(0);
      const baseDecls = base.flatMap((r) =>
        r.nodes.filter((n): n is Declaration => n.type === 'decl'),
      );
      expect(
        baseDecls.filter((d) => d.prop === 'background').map((d) => d.value),
        `${cls} base background`,
      ).toEqual(['var(--surface-1)']);
      expect(baseDecls.filter((d) => FILTERS.has(d.prop)).map((d) => d.prop)).toEqual([]);

      const material: Declaration[] = [];
      root.walkDecls((d) => {
        if (FILTERS.has(d.prop) && d.value !== 'none') {
          expect(guarded(d), `${file}:${String(d.source?.start?.line)} ${d.prop}`).toBe(true);
        }
        if (isMaterialBackground(d)) {
          expect(guarded(d), `${file}:${String(d.source?.start?.line)} ${d.prop}`).toBe(true);
          material.push(d);
        }
      });
      expect(material.length, `${file} has a guarded material background`).toBeGreaterThan(0);
    });
  }
});
