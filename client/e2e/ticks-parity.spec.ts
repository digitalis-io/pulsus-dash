/**
 * `e2e:ticks-parity` (#97 plan §5 D): the interim `valueTicks` equals `engine/fixtures/ticks.json`
 * and `ticks-extreme.json` in every browser engine (Chromium, Firefox and WebKit as pinned by
 * Playwright). The module is loaded as a classic script into a blank page, so the engine's own
 * `Math.log`, `log10` and `**` compute every row.
 */
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { expect, test } from '@playwright/test';

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

const rows = (name: string): FixtureRow[] =>
  JSON.parse(readFileSync(`../engine/fixtures/${name}`, 'utf8')) as FixtureRow[];

test('e2e:ticks-parity valueTicks equals ticks.json and ticks-extreme.json', async ({ page }) => {
  test.setTimeout(60_000);
  const source = readFileSync('src/engine/canvas2d/valueTicks.ts', 'utf8');
  const content = `${stripTypeScriptTypes(source).replace(/^export /gm, '')}
globalThis.__valueTicks = valueTicks;
globalThis.__extremeTicks = extremeTicks;
`;
  await page.setContent('<!doctype html><title>ticks</title>');
  await page.addScriptTag({ content });
  const all = [
    ...rows('ticks.json').map((r) => ({ ...r, file: 'ticks.json' })),
    ...rows('ticks-extreme.json').map((r) => ({ ...r, file: 'ticks-extreme.json' })),
  ];
  const result = await page.evaluate((input) => {
    const num = (v: number | string): number =>
      typeof v === 'number'
        ? v
        : v === 'Infinity'
          ? Infinity
          : v === '-Infinity'
            ? -Infinity
            : Number.NaN;
    const same = (a: number, b: number): boolean => a === b || (Number.isNaN(a) && Number.isNaN(b));
    type T = { min: number; max: number; ticks: number[] };
    const g = globalThis as unknown as {
      __valueTicks: (a: number, b: number, h: number, l: number, base: number) => T;
      __extremeTicks: (a: number, b: number, h: number, l: number) => T;
    };
    const bad: string[] = [];
    for (const [i, r] of input.entries()) {
      const [min, max, h] = [num(r.min), num(r.max), num(r.height)];
      const got =
        r.fn === 'extremeTicks'
          ? g.__extremeTicks(min, max, h, r.label)
          : g.__valueTicks(min, max, h, r.label, r.base ?? 1000);
      const want = { min: num(r.out.min), max: num(r.out.max), ticks: r.out.ticks.map(num) };
      const ok =
        same(got.min, want.min) &&
        same(got.max, want.max) &&
        got.ticks.length === want.ticks.length &&
        got.ticks.every((t, k) => same(t, want.ticks[k] ?? Number.NaN));
      if (!ok) {
        bad.push(
          `${r.file} #${String(i)} ${r.fn ?? 'valueTicks'}(${String(min)}, ${String(max)}, h ${String(h)}, b ${String(r.base)}): ${JSON.stringify(got)} != ${JSON.stringify(want)}`,
        );
      }
    }
    return { count: input.length, bad };
  }, all);
  expect(result.count).toBe(897);
  expect(result.bad.length, result.bad.slice(0, 10).join('\n')).toBe(0);
});
