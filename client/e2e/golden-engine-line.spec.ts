/**
 * `golden:engine-line` (plan #68 C1 §5; T05-005, VIZ-001): the engine's line frames against the
 * Canvas 2D render of the same page, both tiers, inside the plot (edges included): mean ꟻLIP ≤
 * 0.005 and no 8 × 8 tile above 0.25. The plot rects are equal. A window shifted by 1 % and the
 * `gap` fault must fail the same comparison.
 */
import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import { enc, GALLERY, open } from './helpers.ts';
import { canvasShot, compareShots, framesReady, plotRect } from './engine.ts';

const PAGES = ['line-1', 'line-50', 'line-gaps', 'line-600', 'line-extreme'] as const;
const FROM = Date.UTC(2026, 10, 19, 12);
const TO = Date.UTC(2026, 10, 19, 13);

function url(engine: string, shiftMs = 0, extra = ''): string {
  const iso = (ms: number): string => enc(new Date(ms).toISOString());
  return `${GALLERY}?from=${iso(FROM + shiftMs)}&to=${iso(TO + shiftMs)}&refresh=off&engine=${engine}${extra}`;
}

async function shoot(
  page: Page,
  info: TestInfo,
  theme: string,
  target: string,
  name: string,
): Promise<{ path: string; plot: number[]; dpr: number }> {
  await page.addInitScript((t) => {
    localStorage.setItem('pulsus-dash.theme', t);
  }, theme);
  await open(page, target);
  await framesReady(page);
  const id = name.split('@')[0] ?? name;
  return {
    path: await canvasShot(page, id, info, name),
    plot: await plotRect(page, id),
    dpr: await page.evaluate(() => devicePixelRatio),
  };
}

async function pair(
  browser: Browser,
  info: TestInfo,
  o: { id: string; theme: string; scale: number; wasm: string },
): Promise<{ code: number; out: string }> {
  const ctx = async () =>
    browser.newContext({ deviceScaleFactor: o.scale, viewport: { width: 1440, height: 900 } });
  const c2 = await ctx();
  const w = await ctx();
  try {
    const tag = `${o.id}@${o.theme}-${String(o.scale)}`;
    const ref = await shoot(await c2.newPage(), info, o.theme, url('canvas2d'), `${tag}-canvas2d`);
    const got = await shoot(await w.newPage(), info, o.theme, o.wasm, `${tag}-wasm`);
    expect(got.plot, `${tag}: data-plot`).toEqual(ref.plot);
    return compareShots(ref.path, got.path, ref.plot, ref.dpr);
  } finally {
    await c2.close();
    await w.close();
  }
}

for (const leg of [
  { name: 'webgpu', mode: '' },
  { name: 'webgl2', mode: '&mode=t2' },
] as const) {
  test.describe(`golden:engine-line ${leg.name}`, () => {
    test('line pages × themes, and line-50 at scale 2', async ({ browser }, info) => {
      test.setTimeout(240_000);
      const cases = [
        ...PAGES.flatMap((id) => ['dark', 'light'].map((theme) => ({ id, theme, scale: 1 }))),
        { id: 'line-50', theme: 'dark', scale: 2 },
      ];
      for (const c of cases) {
        const r = await pair(browser, info, { ...c, wasm: url('wasm', 0, leg.mode) });
        expect.soft(r.code, `${c.id} ${c.theme} ×${String(c.scale)}: ${r.out}`).toBe(0);
      }
    });

    test('negatives: a 1 % shift and the gap fault fail the comparison', async ({
      browser,
    }, info) => {
      test.setTimeout(120_000);
      const shift = (TO - FROM) / 100;
      const base = { id: 'line-50', theme: 'dark', scale: 1 };
      const shifted = await pair(browser, info, { ...base, wasm: url('wasm', shift, leg.mode) });
      expect(shifted.code, shifted.out).toBe(1);
      const gap = await pair(browser, info, {
        ...base,
        id: 'line-1',
        wasm: url('wasm', 0, `${leg.mode}&fault=gap`),
      });
      expect(gap.code, gap.out).toBe(1);
    });
  });
}
