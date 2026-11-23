/**
 * `e2e:ticks-parity` (#97 plan §5 D and §10 Q1, plan 6): the interim `valueTicks` against
 * `engine/fixtures/ticks.json` and `ticks-extreme.json` in the browser engines Playwright pins. The
 * module is loaded as a classic script into a blank page, so the engine's own `Math.log`, `log10`
 * and `**` compute every row. WebKit's `**` differs from V8's in the last bits for some large
 * powers (plan §8 R2), hence the classes below. The rule, word for word (§10 Q1):
 *
 * **Path parity, every engine, every row.** Every row of `ticks.json` and `ticks-extreme.json`
 * carries `path: 'nice' | 'fallback'`, generated under the pinned Node 24.22.3. `'fallback'`
 * means `fn === 'extremeTicks'` or `niceValueTicks(...) === null`; this includes the collision
 * rejection, which returns null. Each engine computes its own path in-engine the same way. A path
 * that differs from the recorded `path` fails in every engine and every class. Classes are
 * assigned from the recorded `path`, with gap = label + 2:
 * - **F** (`path === 'fallback'`): exact `{min, max, ticks}` in every engine.
 * - **S** (`path === 'nice'`, `height ≤ 2·gap`): exact in Chromium and Firefox. In WebKit, the
 *   tick count and every tick are exact (−0 compared numerically); `min` and `max` are each exact
 *   or within 4 ulps of the recorded value (`ulpDistance` on the IEEE-754 bit patterns); and P1
 *   to P7 hold on WebKit's own result.
 * - **N** (`path === 'nice'`, `height > 2·gap`): exact in Chromium and Firefox. In WebKit, exact,
 *   or P1 to P7 hold.
 *
 * WebKit is follow-up #126.
 */
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { expect, test } from '@playwright/test';
import { ulpDistance } from '../scripts/ulp.ts';

type Path = 'nice' | 'fallback';
type RowClass = 'F' | 'S' | 'N';

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

/** The engines whose S and N rows are checked by class instead of exactly (§10 Q1, #126). */
const NARROW_ENGINES: readonly string[] = ['webkit'];
/** The most ulps an S row's `min` or `max` may differ by in a narrow engine. */
const S_MAX_ULPS = 4;

const num = (v: number | string): number =>
  typeof v === 'number' ? v : v === 'Infinity' ? Infinity : v === '-Infinity' ? -Infinity : NaN;

const same = (a: number, b: number): boolean => a === b || (Number.isNaN(a) && Number.isNaN(b));

const rows = (name: string): (FixtureRow & { file: string; cls: RowClass })[] =>
  (JSON.parse(readFileSync(`../engine/fixtures/${name}`, 'utf8')) as FixtureRow[]).map((r, i) => {
    if (r.path !== 'nice' && r.path !== 'fallback') {
      throw new Error(
        `${name} row ${String(i)} has no path: run npm run engine-fixtures -- --write`,
      );
    }
    const short = num(r.height) <= 2 * (r.label + 2);
    const cls: RowClass = r.path === 'fallback' ? 'F' : short ? 'S' : 'N';
    return { ...r, file: name, cls };
  });

interface Computed {
  readonly got: { min: number; max: number; ticks: number[] };
  readonly path: Path;
  /** P1 to P7 (plan §4.5) that fail on the engine's own result. */
  readonly invariants: string[];
}

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
  // Every row is computed in the page, by the engine under test; the checks run here.
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
      __tickY: (v: number, min: number, max: number, top: number, h: number) => number;
    };
    return input.map((r) => {
      const [lo, hi, h] = [num(r.min), num(r.max), num(r.height)];
      const l = r.label;
      const base = r.base ?? 1000;
      const extreme = r.fn === 'extremeTicks';
      const got = extreme ? g.__extremeTicks(lo, hi, h, l) : g.__valueTicks(lo, hi, h, l, base);
      const fb = extreme || g.__niceValueTicks(lo, hi, h, l, base) === null;
      const gap = l + 2;
      const rel = hi / 2 - lo / 2 >= 5e-10 * Math.max(Math.abs(lo), Math.abs(hi));
      const k = got.ticks.length;
      const bad: string[] = [];
      if (!(k >= 1 && k <= 10_001) || (h >= gap && k < 2)) bad.push('P1');
      if (![got.min, got.max, ...got.ticks].every(Number.isFinite)) bad.push('P2');
      if (got.ticks.some((x, i) => i > 0 && !(x > (got.ticks[i - 1] ?? Number.NaN)))) {
        bad.push('P3');
      }
      if ((rel || fb) && !(got.min <= lo && got.max >= hi)) bad.push('P4');
      if (fb && k >= 2 && got.ticks[0] !== got.min) bad.push('P5');
      for (const top of [0, 8]) {
        for (let i = 1; i < k; i++) {
          const y0 = g.__tickY(got.ticks[i - 1] ?? Number.NaN, got.min, got.max, top, h);
          const y1 = g.__tickY(got.ticks[i] ?? Number.NaN, got.min, got.max, top, h);
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
      const path: 'nice' | 'fallback' = fb ? 'fallback' : 'nice';
      return { got, path, invariants: bad };
    });
  }, all);
  const narrow = NARROW_ENGINES.includes(info.project.name);
  const bad: string[] = [];
  let differS = 0;
  let differN = 0;
  for (const [i, r] of all.entries()) {
    const c = computed[i];
    if (c === undefined) throw new Error(`row ${String(i)} was not computed`);
    const want = { min: num(r.out.min), max: num(r.out.max), ticks: r.out.ticks.map(num) };
    const { got } = c;
    const what = `${r.file} #${String(i)} [${r.cls}] ${r.fn ?? 'valueTicks'}(${String(r.min)}, ${String(r.max)}, h ${String(r.height)}, b ${String(r.base)}): ${JSON.stringify(got)} != ${JSON.stringify(want)}`;
    if (c.path !== r.path) {
      bad.push(`path ${c.path} != recorded ${String(r.path)}: ${what}`);
      continue;
    }
    const ticksOk =
      got.ticks.length === want.ticks.length &&
      got.ticks.every((t, k) => same(t, want.ticks[k] ?? Number.NaN));
    const exact = ticksOk && same(got.min, want.min) && same(got.max, want.max);
    if (!narrow || r.cls === 'F') {
      if (!exact) bad.push(what);
      continue;
    }
    if (r.cls === 'S') {
      const ends =
        ulpDistance(got.min, want.min) <= S_MAX_ULPS &&
        ulpDistance(got.max, want.max) <= S_MAX_ULPS;
      if (!ticksOk) bad.push(`S ticks: ${what}`);
      else if (!ends) bad.push(`S min/max beyond ${String(S_MAX_ULPS)} ulps: ${what}`);
      else if (c.invariants.length > 0) bad.push(`S ${c.invariants.join(',')}: ${what}`);
      else if (!exact) differS += 1;
      continue;
    }
    if (exact) continue;
    differN += 1;
    if (c.invariants.length > 0) bad.push(`N ${c.invariants.join(',')}: ${what}`);
  }
  expect(all.length).toBe(897);
  expect(bad.length, bad.slice(0, 10).join('\n')).toBe(0);
  if (narrow) {
    info.annotations.push({
      type: 'e2e:ticks-parity',
      description: `${info.project.name}: ${String(differS)} S rows and ${String(differN)} N rows differ from the pinned (V8) fixtures within the §10 Q1 rule`,
    });
  }
});
