/**
 * `golden:engine-line` (plan #68 C1 §5; T05-005, VIZ-001): the browser engine against the native
 * renderer (`dash-golden render`) of the same page, theme, CSS size and DPR. Gated in `lavapipe`
 * (WebGL2, `&engine=wasm&mode=t2`, native T2); report-only in `swiftshader` (WebGPU, native T1).
 * Before any comparison the captured canvas must be on the project's tier, status and adapter;
 * both images are `round(css × dpr)`; `compare --max 0.001 --tile-max 0.05` must pass. A window
 * shifted by 1 % and the `gap` fault must fail it. Plan #68 C2b: `line-50` dark hovered at the
 * plot's centre and with a box band (a right drag over 20–40 % of the plot) against
 * `dash-golden render --hover x,y` and `--box x0,x`, within the same limits. Plan #68 C2c1:
 * `line-thresholds` and `line-events`, dark and light. Canvas 2D parity is `canvas2d parity`
 * (engine-mode-matrix.spec.ts): anti-aliasing differs between the two renderers by design.
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Browser, type TestInfo } from '@playwright/test';
import { enc, frame, GALLERY, open, plotOf } from './helpers.ts';
import {
  canvasShot,
  compareImages,
  framesReady,
  leg,
  liveCanvas,
  nativeRender,
  tierOf,
} from './engine.ts';
import { decodePng } from './png.ts';

/** Plan #68 C2c1 adds the layer pages (thresholds, events: `dash-golden render` reads `layer.json`). */
const PAGES = [
  'line-1',
  'line-50',
  'line-gaps',
  'line-600',
  'line-extreme',
  'line-thresholds',
  'line-events',
] as const;
const FROM = Date.UTC(2026, 10, 19, 12);
const TO = Date.UTC(2026, 10, 19, 13);
const LIMITS = { max: 0.001, tileMax: 0.05 };

function url(query: string, shiftMs = 0, extra = ''): string {
  const iso = (ms: number): string => enc(new Date(ms).toISOString());
  return `${GALLERY}?from=${iso(FROM + shiftMs)}&to=${iso(TO + shiftMs)}&refresh=off${query}${extra}`;
}

/** The engine's canvas of `id` and the native render of the same frame; their comparison. */
async function versusNative(
  browser: Browser,
  info: TestInfo,
  o: { id: string; theme: string; scale: number; target: string; act?: 'hover' | 'band' },
): Promise<{ code: number; out: string }> {
  const tier = tierOf(info);
  const ctx = await browser.newContext({
    deviceScaleFactor: o.scale,
    viewport: { width: 1440, height: 900 },
  });
  try {
    const page = await ctx.newPage();
    await page.addInitScript((t) => {
      localStorage.setItem('pulsus-dash.theme', t);
    }, o.theme);
    await open(page, o.target);
    await framesReady(page);
    await expect(liveCanvas(page, o.id)).toHaveAttribute('data-engine', tier.engine);
    const html = page.locator('html');
    await expect(html).toHaveAttribute('data-dash-status', tier.status);
    await expect(html).toHaveAttribute('data-dash-adapter', tier.adapter);
    await expect(html).toHaveAttribute('data-dash-mode', tier.mode);
    await liveCanvas(page, o.id).scrollIntoViewIfNeeded();
    const box = await liveCanvas(page, o.id).boundingBox();
    if (box === null) throw new Error(`${o.id}: no box`);
    const css = [Math.round(box.width), Math.round(box.height)] as const;
    const tag = `${o.id}@${o.theme}-${String(o.scale)}${o.act === undefined ? '' : `-${o.act}`}`;
    // Plan #68 C2b: the overlay at whole page px; the native render gets the canvas-local point.
    const overlay: { hover?: [number, number]; box?: [number, number] } = {};
    if (o.act !== undefined) {
      const plot = await plotOf(frame(page, o.id));
      const px = (f: number): number => Math.round(box.x + plot.x + f * plot.width);
      const py = Math.round(box.y + plot.y + plot.height / 2);
      if (o.act === 'hover') {
        await page.mouse.move(px(0.5), py);
        await expect(frame(page, o.id).locator('[data-chart-tooltip]')).toBeVisible();
        overlay.hover = [px(0.5) - box.x, py - box.y];
      } else {
        await page.mouse.move(px(0.2), py);
        await page.mouse.down({ button: 'right' });
        await page.mouse.move(px(0.4), py, { steps: 4 });
        overlay.box = [px(0.2) - box.x, px(0.4) - box.x];
      }
      // The worker presents the overlay within a few of its frames.
      await page.waitForTimeout(500);
    }
    const got = await canvasShot(page, o.id, info, `${tag}-browser`);
    if (o.act === 'band') await page.mouse.up({ button: 'right' });
    const want = info.outputPath(`${tag}-native.png`);
    nativeRender({
      page: o.id,
      theme: o.theme,
      css,
      dpr: o.scale,
      tier: tier.engine === 'wasm-webgl2' ? 't2' : 't1',
      out: want,
      ...overlay,
    });
    const size = (p: string): [number, number] => {
      const i = decodePng(readFileSync(p));
      return [i.w, i.h];
    };
    const device = css.map((c) => Math.round(c * o.scale));
    expect(size(got), `${tag}: browser image size`).toEqual(device);
    expect(size(want), `${tag}: native image size`).toEqual(device);
    return compareImages(want, got, LIMITS);
  } finally {
    await ctx.close();
  }
}

test.describe('golden:engine-line', () => {
  test('line pages × themes, and line-50 at scale 2, against the native render', async ({
    browser,
  }, info) => {
    test.setTimeout(300_000);
    const tier = tierOf(info);
    await leg(info, async () => {
      const cases = [
        ...PAGES.flatMap((id) => ['dark', 'light'].map((theme) => ({ id, theme, scale: 1 }))),
        { id: 'line-50', theme: 'dark', scale: 2 },
        { id: 'line-50', theme: 'dark', scale: 1, act: 'hover' as const },
        { id: 'line-50', theme: 'dark', scale: 1, act: 'band' as const },
      ];
      for (const c of cases) {
        const r = await versusNative(browser, info, { ...c, target: url(tier.query) });
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
      const shifted = await versusNative(browser, info, {
        id: 'line-50',
        theme: 'dark',
        scale: 1,
        target: url(tier.query, shift),
      });
      const gap = await versusNative(browser, info, {
        id: 'line-1',
        theme: 'dark',
        scale: 1,
        target: url(tier.query, 0, '&fault=gap'),
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
