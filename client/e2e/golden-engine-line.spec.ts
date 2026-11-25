/**
 * `golden:engine-line` (plan #68 C1 §5; T05-005, VIZ-001): the engine's line frames against the
 * Canvas 2D render of the same page, inside the plot (edges included): mean ꟻLIP ≤ 0.005 and no
 * 8 × 8 tile above 0.25; equal plot rects. Gated in `lavapipe` (WebGL2, `&engine=wasm&mode=t2`);
 * report-only in `swiftshader` (WebGPU). Before any comparison the captured canvas must be on the
 * project's tier, status and adapter. A window shifted by 1 % and the `gap` fault must fail.
 */
import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import { enc, GALLERY, open } from './helpers.ts';
import {
  canvasShot,
  compareShots,
  framesReady,
  leg,
  liveCanvas,
  plotRect,
  tierOf,
  type Tier,
} from './engine.ts';

const PAGES = ['line-1', 'line-50', 'line-gaps', 'line-600', 'line-extreme'] as const;
const FROM = Date.UTC(2026, 10, 19, 12);
const TO = Date.UTC(2026, 10, 19, 13);

function url(query: string, shiftMs = 0, extra = ''): string {
  const iso = (ms: number): string => enc(new Date(ms).toISOString());
  return `${GALLERY}?from=${iso(FROM + shiftMs)}&to=${iso(TO + shiftMs)}&refresh=off${query}${extra}`;
}

interface Shot {
  path: string;
  plot: number[];
  dpr: number;
}

async function shoot(
  page: Page,
  info: TestInfo,
  theme: string,
  target: string,
  id: string,
  name: string,
  tier: Tier | null,
): Promise<Shot> {
  await page.addInitScript((t) => {
    localStorage.setItem('pulsus-dash.theme', t);
  }, theme);
  await open(page, target);
  await framesReady(page);
  if (tier !== null) {
    // The captured canvas is the engine's, on the project's tier.
    await expect(liveCanvas(page, id)).toHaveAttribute('data-engine', tier.engine);
    const html = page.locator('html');
    await expect(html).toHaveAttribute('data-dash-status', tier.status);
    await expect(html).toHaveAttribute('data-dash-adapter', tier.adapter);
  }
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
    const ref = await shoot(
      await c2.newPage(),
      info,
      o.theme,
      url('&engine=canvas2d'),
      o.id,
      `${tag}-canvas2d`,
      null,
    );
    const got = await shoot(
      await w.newPage(),
      info,
      o.theme,
      o.wasm,
      o.id,
      `${tag}-wasm`,
      tierOf(info),
    );
    expect(got.plot, `${tag}: data-plot`).toEqual(ref.plot);
    return compareShots(ref.path, got.path, ref.plot, ref.dpr);
  } finally {
    await c2.close();
    await w.close();
  }
}

test.describe('golden:engine-line', () => {
  test('line pages × themes, and line-50 at scale 2', async ({ browser }, info) => {
    test.setTimeout(300_000);
    const tier = tierOf(info);
    await leg(info, async () => {
      const cases = [
        ...PAGES.flatMap((id) => ['dark', 'light'].map((theme) => ({ id, theme, scale: 1 }))),
        { id: 'line-50', theme: 'dark', scale: 2 },
      ];
      for (const c of cases) {
        const r = await pair(browser, info, { ...c, wasm: url(tier.query) });
        const what = `${c.id} ${c.theme} ×${String(c.scale)}: ${r.out.trim()}`;
        if (tier.goldens) expect.soft(r.code, what).toBe(0);
        else console.log(`golden:engine-line report-only (${info.project.name}): ${what}`);
      }
    });
  });

  test('negatives: a 1 % shift and the gap fault fail the comparison', async ({
    browser,
  }, info) => {
    test.setTimeout(120_000);
    const tier = tierOf(info);
    await leg(info, async () => {
      const shift = (TO - FROM) / 100;
      const base = { id: 'line-50', theme: 'dark', scale: 1 };
      const shifted = await pair(browser, info, { ...base, wasm: url(tier.query, shift) });
      const gap = await pair(browser, info, {
        ...base,
        id: 'line-1',
        wasm: url(tier.query, 0, '&fault=gap'),
      });
      if (tier.goldens) {
        expect(shifted.code, shifted.out).toBe(1);
        expect(gap.code, gap.out).toBe(1);
      } else {
        console.log(
          `golden:engine-line negatives report-only (${info.project.name}): shift ${String(shifted.code)}, gap ${String(gap.code)}`,
        );
      }
    });
  });
});
