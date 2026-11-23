/**
 * `e2e:ticks-parity` (#97 plan §5 D): the interim `valueTicks` equals `engine/fixtures/ticks.json`
 * and `ticks-extreme.json` in the browser engines Playwright pins. The module is loaded as a
 * classic script into a blank page, so the engine's own `Math.log`, `log10` and `**` compute every
 * row.
 *
 * Chromium and Firefox equal every row. WebKit's `**` differs from V8's in the last bits for some
 * large powers, so its nice-search rows can snap to a neighbouring double (plan §8 R2, §10 Q1). In
 * WebKit the exact rows are the fallback rows, which are pure IEEE arithmetic (`extremeTicks`, or
 * `niceValueTicks` null under V8), and the short-plot rows (height ≤ 2 · (label + 2)); every other
 * nice-search row that differs must still hold the bounded-ticks invariants P1 to P7 (plan §4.5).
 */
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { expect, test } from '@playwright/test';
import { niceValueTicks } from '../src/engine/canvas2d/valueTicks.ts';

interface FixtureRow {
  readonly fn?: 'valueTicks' | 'extremeTicks';
  readonly min: number | string;
  readonly max: number | string;
  readonly height: number | string;
  readonly label: number;
  readonly base: 1000 | 1024 | null;
  readonly out: {
    readonly min: number | string;
    readonly max: number | string;
    readonly ticks: readonly (number | string)[];
  };
}

/** Engines whose nice-search rows are checked against P1 to P7 instead of exactly (§10 Q1). */
const NARROW_ENGINES: readonly string[] = ['webkit'];

const num = (v: number | string): number =>
  typeof v === 'number' ? v : v === 'Infinity' ? Infinity : v === '-Infinity' ? -Infinity : NaN;

const rows = (name: string): (FixtureRow & { file: string; exact: boolean })[] =>
  (JSON.parse(readFileSync(`../engine/fixtures/${name}`, 'utf8')) as FixtureRow[]).map((r) => {
    const fallback =
      r.fn === 'extremeTicks' ||
      niceValueTicks(num(r.min), num(r.max), num(r.height), r.label, r.base ?? 1000) === null;
    // Short plot: at most two label gaps tall, where the 3 → 2 → 1 thinning applies (A13, A14,
    // A21 to A29 and the short seeded rows).
    const short = num(r.height) <= 2 * (r.label + 2);
    return { ...r, file: name, exact: fallback || short };
  });

test('e2e:ticks-parity valueTicks equals ticks.json and ticks-extreme.json', async ({
  page,
}, info) => {
  test.setTimeout(60_000);
  const source = readFileSync('src/engine/canvas2d/valueTicks.ts', 'utf8');
  const content = `${stripTypeScriptTypes(source).replace(/^export /gm, '')}
globalThis.__valueTicks = valueTicks;
globalThis.__extremeTicks = extremeTicks;
globalThis.__niceValueTicks = niceValueTicks;
globalThis.__tickY = tickY;
`;
  await page.setContent('<!doctype html><title>ticks</title>');
  await page.addScriptTag({ content });
  const all = [...rows('ticks.json'), ...rows('ticks-extreme.json')];
  const narrow = NARROW_ENGINES.includes(info.project.name);
  const result = await page.evaluate(
    ({ input, narrow }) => {
      const num = (v: number | string): number =>
        typeof v === 'number'
          ? v
          : v === 'Infinity'
            ? Infinity
            : v === '-Infinity'
              ? -Infinity
              : Number.NaN;
      const same = (a: number, b: number): boolean =>
        a === b || (Number.isNaN(a) && Number.isNaN(b));
      type T = { min: number; max: number; ticks: number[] };
      const g = globalThis as unknown as {
        __valueTicks: (a: number, b: number, h: number, l: number, base: number) => T;
        __extremeTicks: (a: number, b: number, h: number, l: number) => T;
        __niceValueTicks: (a: number, b: number, h: number, l: number, base: number) => T | null;
        __tickY: (v: number, min: number, max: number, top: number, h: number) => number;
      };
      /** §4.5 P1 to P7 on the engine's own result: the invariants that fail. */
      const invariants = (lo: number, hi: number, h: number, l: number, base: number): string[] => {
        const v = g.__valueTicks(lo, hi, h, l, base);
        const fb = g.__niceValueTicks(lo, hi, h, l, base) === null;
        const gap = l + 2;
        const rel = hi / 2 - lo / 2 >= 5e-10 * Math.max(Math.abs(lo), Math.abs(hi));
        const k = v.ticks.length;
        const bad: string[] = [];
        if (!(k >= 1 && k <= 10_001) || (h >= gap && k < 2)) bad.push('P1');
        if (![v.min, v.max, ...v.ticks].every(Number.isFinite)) bad.push('P2');
        if (v.ticks.some((x, i) => i > 0 && !(x > (v.ticks[i - 1] ?? Number.NaN)))) bad.push('P3');
        if ((rel || fb) && !(v.min <= lo && v.max >= hi)) bad.push('P4');
        if (fb && k >= 2 && v.ticks[0] !== v.min) bad.push('P5');
        for (const top of [0, 8]) {
          for (let i = 1; i < k; i++) {
            const y0 = g.__tickY(v.ticks[i - 1] ?? Number.NaN, v.min, v.max, top, h);
            const y1 = g.__tickY(v.ticks[i] ?? Number.NaN, v.min, v.max, top, h);
            const d = y0 - y1;
            const ok =
              Number.isFinite(y0) &&
              Number.isFinite(y1) &&
              Number.isFinite(d) &&
              d >= gap * (1 - 1e-9);
            if (!ok && !bad.includes('P6')) bad.push('P6');
          }
        }
        if (k - 1 > Math.floor(h / gap)) bad.push('P7');
        return bad;
      };
      const bad: string[] = [];
      let differ = 0;
      for (const [i, r] of input.entries()) {
        const [min, max, h] = [num(r.min), num(r.max), num(r.height)];
        const base = r.base ?? 1000;
        const got =
          r.fn === 'extremeTicks'
            ? g.__extremeTicks(min, max, h, r.label)
            : g.__valueTicks(min, max, h, r.label, base);
        const want = { min: num(r.out.min), max: num(r.out.max), ticks: r.out.ticks.map(num) };
        const ok =
          same(got.min, want.min) &&
          same(got.max, want.max) &&
          got.ticks.length === want.ticks.length &&
          got.ticks.every((t, k) => same(t, want.ticks[k] ?? Number.NaN));
        if (ok) continue;
        const what = `${r.file} #${String(i)} ${r.fn ?? 'valueTicks'}(${String(min)}, ${String(max)}, h ${String(h)}, b ${String(r.base)}): ${JSON.stringify(got)} != ${JSON.stringify(want)}`;
        if (narrow && !r.exact) {
          differ += 1;
          const p = invariants(min, max, h, r.label, base);
          if (p.length > 0) bad.push(`${p.join(',')} ${what}`);
        } else {
          bad.push(what);
        }
      }
      return { count: input.length, bad, differ };
    },
    { input: all, narrow },
  );
  expect(result.count).toBe(897);
  expect(result.bad.length, result.bad.slice(0, 10).join('\n')).toBe(0);
  if (narrow) {
    info.annotations.push({
      type: 'e2e:ticks-parity',
      description: `${info.project.name}: ${String(result.differ)} nice-search rows differ from the V8 fixtures and hold P1 to P7`,
    });
  }
});
