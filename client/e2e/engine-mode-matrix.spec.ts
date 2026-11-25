/**
 * `e2e:mode-matrix` (plan #68 C1 §5; VIZ-001, T03-025, PRF-009): each engine mode on the gallery,
 * and the WebGPU line-presence check. `lavapipe` runs the Canvas 2D, WebGL2, no-OffscreenCanvas,
 * Static and integrity legs; `swiftshader` the WebGPU leg and the line presence (report-only
 * under `engine-legs.json`).
 */
import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import { GALLERY_IDS, GALLERY_URL, open } from './helpers.ts';
import {
  ENGINE_URL,
  engineRequests,
  engines,
  framesReady,
  leg,
  LINE_IDS,
  liveCanvas,
  plotInk,
  plotRect,
  TIERS,
} from './engine.ts';
import { decodePng, type Rgba } from './png.ts';

declare global {
  interface Window {
    __draws: string[];
  }
}

const all = (kind: string): Record<string, string> =>
  Object.fromEntries(GALLERY_IDS.map((id) => [id, kind]));
const lines = (kind: string): Record<string, string> =>
  Object.fromEntries(
    GALLERY_IDS.map((id) => [id, (LINE_IDS as readonly string[]).includes(id) ? kind : 'canvas2d']),
  );

async function legOf(page: Page, url: string): Promise<void> {
  await open(page, url);
  await framesReady(page);
  expect(await plotInk(page, 'line-50')).toBeGreaterThan(1000);
}

const only = (info: TestInfo, project: string): void => {
  test.skip(info.project.name !== project, `${project} project only`);
};

test.describe('e2e:mode-matrix', () => {
  test('default: Canvas 2D, no engine request', async ({ page }, info) => {
    only(info, 'lavapipe');
    const req = engineRequests(page);
    await legOf(page, GALLERY_URL);
    expect(await engines(page)).toEqual(all('canvas2d'));
    expect(req).toEqual([]);
  });

  test('webgl2: mode=t2 is status 2 on lavapipe', async ({ page }, info) => {
    only(info, 'lavapipe');
    const t = TIERS['lavapipe'];
    await legOf(page, `${GALLERY_URL}${t?.query ?? ''}`);
    const html = page.locator('html');
    await expect(html).toHaveAttribute('data-dash-status', '2');
    await expect(html).toHaveAttribute('data-dash-mode', 'mt');
    await expect(html).toHaveAttribute('data-dash-adapter', /llvmpipe/);
    expect(await engines(page)).toEqual(lines('wasm-webgl2'));
  });

  test('webgpu: status 1 on SwiftShader, every line frame drawn', async ({ page }, info) => {
    only(info, 'swiftshader');
    await leg(info, async () => {
      await page.addInitScript(() => {
        window.__draws = [];
        new PerformanceObserver((l) => {
          for (const e of l.getEntries()) {
            const d = (e as PerformanceMeasure).detail as { frame?: string } | null;
            if (e.name === 'chart-draw' && typeof d?.frame === 'string')
              window.__draws.push(d.frame);
          }
        }).observe({ type: 'measure' });
      });
      await legOf(page, ENGINE_URL);
      const html = page.locator('html');
      await expect(html).toHaveAttribute('data-dash-status', '1');
      await expect(html).toHaveAttribute('data-dash-adapter', /swiftshader/i);
      expect(await engines(page)).toEqual(lines('wasm-webgpu'));
      const ids = await Promise.all(
        LINE_IDS.map((id) =>
          page
            .locator(`[data-gallery-id="${id}"] [data-chart-frame]`)
            .getAttribute('data-frame-id'),
        ),
      );
      await expect
        .poll(async () => {
          const d = await page.evaluate(() => window.__draws);
          return ids.every((id) => id !== null && d.includes(id));
        })
        .toBe(true);
    });
  });

  test('no-offscreen: Canvas 2D, no engine request', async ({ page }, info) => {
    only(info, 'lavapipe');
    await page.addInitScript(() => {
      Reflect.deleteProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen');
    });
    const req = engineRequests(page);
    await legOf(page, `${ENGINE_URL}&mode=t2`);
    expect(await engines(page)).toEqual(all('canvas2d'));
    expect(req).toEqual([]);
  });

  test('static: Canvas 2D', async ({ page }, info) => {
    only(info, 'lavapipe');
    await legOf(page, `${ENGINE_URL}&mode=static`);
    expect(await engines(page)).toEqual(all('canvas2d'));
  });

  test('integrity: a flipped wasm byte is refused twice, then Canvas 2D', async ({
    page,
  }, info) => {
    only(info, 'lavapipe');
    const wasm: string[] = [];
    await page.route(/\/assets\/dash-engine-[^/]+\.wasm$/, async (route) => {
      wasm.push(route.request().url());
      const res = await route.fetch();
      const body = Buffer.from(await res.body());
      body[body.length >> 1] = (body[body.length >> 1] ?? 0) ^ 0xff;
      await route.fulfill({ response: res, body });
    });
    const warnings: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'warning') warnings.push(m.text());
    });
    await legOf(page, `${ENGINE_URL}&mode=t2`);
    expect(await engines(page)).toEqual(all('canvas2d'));
    expect(wasm).toHaveLength(2);
    expect(warnings.some((w) => w.includes('engine_integrity_failed'))).toBe(true);
  });
});

/** `line-1`'s canvas (dark) on `query`, device px. */
async function shot(
  browser: Browser,
  query: string,
): Promise<{ img: Rgba; plot: number[]; dpr: number }> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await ctx.newPage();
    await open(page, `${GALLERY_URL}${query}`);
    await framesReady(page);
    return {
      img: decodePng(await liveCanvas(page, 'line-1').screenshot({ scale: 'device' })),
      plot: await plotRect(page, 'line-1'),
      dpr: await page.evaluate(() => devicePixelRatio),
    };
  } finally {
    await ctx.close();
  }
}

/** The largest channel difference at (x, y), or over its 3 × 3 neighbourhood with `around`. */
function diff(a: Rgba, b: Rgba, x: number, y: number, around = false): number {
  let m = 0;
  for (let dy = around ? -1 : 0; dy <= (around ? 1 : 0); dy++) {
    for (let dx = around ? -1 : 0; dx <= (around ? 1 : 0); dx++) {
      const i = ((y + dy) * a.w + (x + dx)) * 4;
      for (let k = 0; k < 3; k++)
        m = Math.max(m, Math.abs((a.px[i + k] ?? 0) - (b.px[i + k] ?? 0)));
    }
  }
  return m;
}

/** 32 line points evenly in x and 32 background points ≥ 4 px from the line (the Canvas 2D mask). */
function probes(withLine: Rgba, without: Rgba, plot: number[], dpr: number) {
  const [x = 0, y = 0, w = 0, h = 0] = plot.map((v) => Math.round(v * dpr));
  const mask = (px: number, py: number): boolean => diff(withLine, without, px, py) >= 64;
  const near = (px: number, py: number): boolean => {
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) if (mask(px + dx, py + dy)) return true;
    return false;
  };
  const line: [number, number][] = [];
  const background: [number, number][] = [];
  for (let k = 0; k < 32; k++) {
    const px = x + 2 + Math.floor(((w - 4) * (k + 0.5)) / 32);
    const ys: number[] = [];
    for (let py = y + 1; py < y + h - 1; py++) if (mask(px, py)) ys.push(py);
    const mid = ys[ys.length >> 1];
    if (mid !== undefined) line.push([px, mid]);
    for (let j = 0; j < h; j += 7) {
      const py = y + 4 + ((j + k * 13) % Math.max(1, h - 8));
      if (!near(px, py)) {
        background.push([px, py]);
        break;
      }
    }
  }
  return { line, background };
}

test.describe('webgpu line presence (VIZ-001)', () => {
  test('the WebGPU engine draws line-1 where Canvas 2D does', async ({ browser }, info) => {
    only(info, 'swiftshader');
    test.setTimeout(120_000);
    await leg(info, async () => {
      const ref = await shot(browser, '&engine=canvas2d');
      const refEmpty = await shot(browser, '&engine=canvas2d&fault=empty');
      const p = probes(ref.img, refEmpty.img, ref.plot, ref.dpr);
      expect(p.line.length).toBe(32);
      expect(p.background.length).toBe(32);
      const count = (a: Rgba, b: Rgba, pts: [number, number][], around: boolean): number =>
        pts.filter(([x, y]) => diff(a, b, x, y, around) >= 64).length;
      const empty = await shot(browser, '&engine=wasm&fault=empty');
      const wasm = await shot(browser, '&engine=wasm');
      expect(count(wasm.img, empty.img, p.line, true)).toBeGreaterThanOrEqual(28);
      expect(count(wasm.img, empty.img, p.background, false)).toBeLessThanOrEqual(8);
      // The negative: with no line drawn the same check fails.
      const noline = await shot(browser, '&engine=wasm&fault=noline');
      expect(count(noline.img, empty.img, p.line, true)).toBeLessThan(28);
    });
  });
});
