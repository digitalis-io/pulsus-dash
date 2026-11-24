/**
 * `e2e:ticks-parity` (#97 plan §5 D, #126): the interim `valueTicks` against
 * `engine/fixtures/ticks.json` and `ticks-extreme.json` in every browser engine Playwright pins
 * (Chromium, Firefox and WebKit). The module is loaded as a classic script into a blank page, so
 * the engine under test computes every row with its own `Math.log` and `Math.log10`. The integer
 * powers come from `pow10` and `powBase`, which use no `**` (`unit:js-pow`), so every engine
 * computes V8's powers.
 *
 * - **Powers:** in the page, `pow10` and `powBase` equal all 855 rows of `pow.json` (`Object.is`).
 * - **Ticks:** every row of `ticks.json` and `ticks-extreme.json` carries
 *   `path: 'nice' | 'fallback'`, generated under the pinned Node 24.22.3. `'fallback'` means
 *   `fn === 'extremeTicks'` or `niceValueTicks(...) === null`; this includes the collision
 *   rejection, which returns null. In every engine, each row takes its recorded path and equals
 *   `out` exactly: `min`, `max`, the tick count and every tick.
 */
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { expect, test } from '@playwright/test';

type Path = 'nice' | 'fallback';

interface FixtureRow {
  readonly fn?: 'valueTicks' | 'extremeTicks';
  readonly min: number | string;
  readonly max: number | string;
  readonly height: number | string;
  readonly label: number;
  readonly base: 1000 | 1024 | null;
  readonly path?: Path;
  readonly out: {
    readonly min: number | string;
    readonly max: number | string;
    readonly ticks: readonly (number | string)[];
  };
}

interface PowRow {
  readonly base: 10 | 1000 | 1024;
  readonly p: number;
  readonly v: number;
}

const num = (v: number | string): number =>
  typeof v === 'number' ? v : v === 'Infinity' ? Infinity : v === '-Infinity' ? -Infinity : NaN;

const same = (a: number, b: number): boolean => a === b || (Number.isNaN(a) && Number.isNaN(b));

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(`../engine/fixtures/${name}`, 'utf8'));

const rows = (name: string): (FixtureRow & { file: string })[] =>
  (fixture(name) as FixtureRow[]).map((r, i) => {
    if (r.path !== 'nice' && r.path !== 'fallback') {
      throw new Error(
        `${name} row ${String(i)} has no path: run npm run engine-fixtures -- --write`,
      );
    }
    return { ...r, file: name };
  });

interface Computed {
  readonly got: { min: number; max: number; ticks: number[] };
  readonly path: Path;
}

test('e2e:ticks-parity valueTicks equals ticks.json and ticks-extreme.json', async ({ page }) => {
  test.setTimeout(60_000);
  const source = readFileSync('src/engine/canvas2d/valueTicks.ts', 'utf8');
  const content = `${stripTypeScriptTypes(source).replace(/^export /gm, '')}
globalThis.__valueTicks = valueTicks;
globalThis.__extremeTicks = extremeTicks;
globalThis.__niceValueTicks = niceValueTicks;
globalThis.__pow10 = pow10;
globalThis.__powBase = powBase;
`;
  await page.setContent('<!doctype html><title>ticks</title>');
  await page.addScriptTag({ content });

  // (a) The powers, computed in the page by the engine under test.
  const pow = fixture('pow.json') as PowRow[];
  const powBad: string[] = await page.evaluate((input) => {
    const g = globalThis as unknown as {
      __pow10: (k: number) => number;
      __powBase: (base: number, p: number) => number;
    };
    return input
      .map((r) => ({ r, got: r.base === 10 ? g.__pow10(r.p) : g.__powBase(r.base, r.p) }))
      .filter(({ r, got }) => !Object.is(got, r.v))
      .map(({ r, got }) => `${String(r.base)} ** ${String(r.p)}: ${String(got)} != ${String(r.v)}`);
  }, pow);
  expect(pow.length).toBe(855);
  expect(powBad.length, powBad.slice(0, 10).join('\n')).toBe(0);

  // (b) Every tick row, computed in the page; the checks run here.
  const all = [...rows('ticks.json'), ...rows('ticks-extreme.json')];
  const computed: Computed[] = await page.evaluate((input) => {
    const num = (v: number | string): number =>
      typeof v === 'number'
        ? v
        : v === 'Infinity'
          ? Infinity
          : v === '-Infinity'
            ? -Infinity
            : Number.NaN;
    type T = { min: number; max: number; ticks: number[] };
    const g = globalThis as unknown as {
      __valueTicks: (a: number, b: number, h: number, l: number, base: number) => T;
      __extremeTicks: (a: number, b: number, h: number, l: number) => T;
      __niceValueTicks: (a: number, b: number, h: number, l: number, base: number) => T | null;
    };
    return input.map((r) => {
      const [lo, hi, h] = [num(r.min), num(r.max), num(r.height)];
      const l = r.label;
      const base = r.base ?? 1000;
      const extreme = r.fn === 'extremeTicks';
      const got = extreme ? g.__extremeTicks(lo, hi, h, l) : g.__valueTicks(lo, hi, h, l, base);
      const fb = extreme || g.__niceValueTicks(lo, hi, h, l, base) === null;
      const path: 'nice' | 'fallback' = fb ? 'fallback' : 'nice';
      return { got, path };
    });
  }, all);
  const bad: string[] = [];
  for (const [i, r] of all.entries()) {
    const c = computed[i];
    if (c === undefined) throw new Error(`row ${String(i)} was not computed`);
    const want = { min: num(r.out.min), max: num(r.out.max), ticks: r.out.ticks.map(num) };
    const { got } = c;
    const what = `${r.file} #${String(i)} ${r.fn ?? 'valueTicks'}(${String(r.min)}, ${String(r.max)}, h ${String(r.height)}, b ${String(r.base)}): ${JSON.stringify(got)} != ${JSON.stringify(want)}`;
    if (c.path !== r.path) {
      bad.push(`path ${c.path} != recorded ${String(r.path)}: ${what}`);
      continue;
    }
    const exact =
      got.ticks.length === want.ticks.length &&
      got.ticks.every((t, k) => same(t, want.ticks[k] ?? Number.NaN)) &&
      same(got.min, want.min) &&
      same(got.max, want.max);
    if (!exact) bad.push(what);
  }
  expect(all.length).toBe(897);
  expect(bad.length, bad.slice(0, 10).join('\n')).toBe(0);
});
