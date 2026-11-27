/**
 * `unit:radius-scale` (#282 Part 2a, VL-019 as amended): every corner in the client's CSS comes
 * from the radius scale (3/4/6/8/10 px: `--radius-tag`, `--radius-xs`, `--radius`, `--radius-md`,
 * `--radius-lg`), `0`, `50%` (dots) or `inherit`, alone or in a `calc()` of these; no capsules.
 * The generated `tokens.css` is skipped: it defines the scale.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import valueParser from 'postcss-value-parser';
import { describe, expect, it } from 'vitest';

const CLIENT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE = fileURLToPath(
  new URL('./__fixtures__/radius-scale/capsules.module.css', import.meta.url),
);
const GENERATED = new Set(['src/styles/tokens.css']);
const SCALE = new Set(['--radius', '--radius-xs', '--radius-md', '--radius-lg', '--radius-tag']);
const KEYWORDS = new Set(['0', '50%', 'inherit']);
/** Operators inside a `calc()`; a radius may be a sum or a difference of scale values. */
const CALC_WORDS = new Set(['+', '-', '*', '/']);

/** Whether a `border-radius*` value is made only of the scale, `0`, `50%` and `inherit`. */
export function radiusAllowed(value: string): boolean {
  let ok = true;
  const walk = (nodes: valueParser.Node[], inCalc: boolean): void => {
    for (const n of nodes) {
      if (n.type === 'space' || n.type === 'div' || n.type === 'comment') continue;
      if (n.type === 'function') {
        if (n.value === 'var') {
          const name = n.nodes.find((x) => x.type === 'word');
          if (n.nodes.filter((x) => x.type !== 'space').length !== 1) ok = false;
          if (name === undefined || !SCALE.has(name.value)) ok = false;
        } else if (n.value === 'calc' || n.value === '') {
          walk(n.nodes, true);
        } else {
          ok = false;
        }
        continue;
      }
      if (n.type === 'word') {
        if (KEYWORDS.has(n.value)) continue;
        // Unitless factors and the borders' own token are allowed inside calc() only.
        if (inCalc && (CALC_WORDS.has(n.value) || /^\d+(\.\d+)?$/.test(n.value))) continue;
        ok = false;
        continue;
      }
      ok = false;
    }
  };
  walk(valueParser(value).nodes, false);
  return ok;
}

/** `file:line value` for every `border-radius*` declaration outside the scale. */
export function radiusFindings(file: string, css: string): string[] {
  const out: string[] = [];
  postcss.parse(css, { from: file }).walkDecls((d) => {
    if (!/^border(-[a-z]+)*-radius$/.test(d.prop)) return;
    if (!radiusAllowed(d.value))
      out.push(`${file}:${String(d.source?.start?.line ?? 0)} ${d.value}`);
  });
  return out;
}

function cssFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...cssFiles(p));
    else if (e.name.endsWith('.css')) out.push(p);
  }
  return out;
}

describe('unit:radius-scale (VL-019)', () => {
  it('finds a capsule and a spacing-token corner in the fixture, once each', () => {
    const f = radiusFindings('capsules.module.css', readFileSync(FIXTURE, 'utf8'));
    expect(f).toEqual([
      'capsules.module.css:2 var(--radius-pill)',
      'capsules.module.css:6 var(--space-8)',
    ]);
  });

  it('allows the scale, 0, 50 %, inherit and calc() of these', () => {
    for (const v of [
      '0',
      '50%',
      'inherit',
      'var(--radius)',
      'var(--radius-tag)',
      'var(--radius) 0 0 var(--radius)',
      'calc(var(--radius-md) - var(--radius-xs))',
    ]) {
      expect(radiusAllowed(v), v).toBe(true);
    }
    for (const v of ['9999px', 'var(--radius-pill)', 'var(--space-8)', '4px', 'var(--x, 4px)']) {
      expect(radiusAllowed(v), v).toBe(false);
    }
  });

  it('every corner in src/ is on the scale', () => {
    const findings = cssFiles(join(CLIENT_ROOT, 'src'))
      .map((p) => relative(CLIENT_ROOT, p))
      .filter((p) => !GENERATED.has(p))
      .flatMap((p) => radiusFindings(p, readFileSync(join(CLIENT_ROOT, p), 'utf8')));
    expect(findings).toEqual([]);
  });
});
