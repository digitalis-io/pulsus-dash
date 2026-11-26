/**
 * `e2e:mode-matrix` (plan #68 C1 §5, plan #256 §5; VIZ-001, T03-025, PRF-009, ADR-0031): each engine
 * mode on the gallery, and the WebGPU line-presence check. The default legs (M1–M3, M5–M12) run on
 * the unflagged release BFF (`RELEASE_URL`), M4 and the integrity leg on the fault build (pinned to
 * Canvas 2D by `VITE_ENGINE=canvas2d`), M13–M14 on `vite preview` of `dist-release-stub` with its
 * computed manifest, M15 on the dev server. `lavapipe` runs every leg; `swiftshader` M1, the WebGPU
 * leg and the line presence (report-only under `engine-legs.json`).
 */
import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import { GALLERY_IDS, GALLERY_URL, open } from './helpers.ts';
import {
  canvasPng,
  ENGINE_URL,
  engineRequests,
  engines,
  framesReady,
  leg,
  LINE_IDS,
  plotInk,
  plotRect,
  RELEASE_URL,
  tierOf,
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

/** `vite preview` of `dist-release-stub` (its computed manifest, plan #256 §3.5). */
const PREVIEW_URL = 'http://localhost:4177';
/** The dev server with the engine built and no `VITE_ENGINE`. */
const DEV_URL = 'http://localhost:5175';

/** A leg that must stay on Canvas 2D and never request an engine file. */
async function canvasLeg(page: Page, url: string): Promise<void> {
  const req = engineRequests(page);
  await legOf(page, url);
  expect(await engines(page)).toEqual(all('canvas2d'));
  expect(req).toEqual([]);
}

/** The byte flip of the integrity legs: every engine wasm served with one byte changed. */
async function flipWasm(page: Page): Promise<string[]> {
  const wasm: string[] = [];
  await page.route(/\/assets\/dash-engine-[^/]+\.wasm$/, async (route) => {
    wasm.push(route.request().url());
    const res = await route.fetch();
    const body = Buffer.from(await res.body());
    body[body.length >> 1] = (body[body.length >> 1] ?? 0) ^ 0xff;
    await route.fulfill({ response: res, body });
  });
  return wasm;
}

function warningsOf(page: Page): string[] {
  const warnings: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'warning') warnings.push(m.text());
  });
  return warnings;
}

/** The engine is the default (ADR-0031): the unflagged release BFF, its signed manifest. */
test.describe('e2e:mode-matrix default (release BFF)', () => {
  test.use({ baseURL: RELEASE_URL });

  test('M1 default: the engine, no flag', async ({ page }, info) => {
    const tier = tierOf(info);
    await leg(info, async () => {
      await legOf(page, GALLERY_URL);
      await expect(page.locator('html')).toHaveAttribute('data-dash-status', tier.status);
      expect(await engines(page)).toEqual(lines(tier.engine));
    });
  });

  test('M2 default on a board: the line panel on the engine, the stat on Canvas 2D', async ({
    page,
  }, info) => {
    only(info, 'lavapipe');
    await open(page, '/t/demo/board/b-1');
    const p1 = page.locator('[data-panel-id="p-1"] [data-chart-frame]');
    await expect(p1).toHaveCount(1);
    await expect(p1).toHaveAttribute('data-frame-ready', 'true');
    const c1 = p1.locator('canvas:not([data-retired])');
    await expect(c1).toHaveCount(1);
    await expect(c1).toHaveAttribute('data-engine', 'wasm-webgl2');
    await expect(page.locator('html')).toHaveAttribute('data-dash-status', '2');
    const c2 = page.locator('[data-panel-id="p-2"] canvas:not([data-retired])');
    await expect(c2).toHaveAttribute('data-engine', 'canvas2d');
  });

  test('M3 ?engine=canvas2d: Canvas 2D, no engine request', async ({ page }, info) => {
    only(info, 'lavapipe');
    await canvasLeg(page, `${GALLERY_URL}&engine=canvas2d`);
  });

  test('M5 no-offscreen: Canvas 2D, no engine request', async ({ page }, info) => {
    only(info, 'lavapipe');
    await page.addInitScript(() => {
      Reflect.deleteProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen');
    });
    await canvasLeg(page, `${GALLERY_URL}&mode=t2`);
  });

  for (const [n, mode] of [
    ['M6', 'static'],
    ['M7', 'st'],
    ['M8', 'mtr'],
  ] as const) {
    test(`${n} mode=${mode}: Canvas 2D, no engine request`, async ({ page }, info) => {
      only(info, 'lavapipe');
      await canvasLeg(page, `${GALLERY_URL}&mode=${mode}`);
    });
  }

  test('M9 not isolated: Canvas 2D, no engine request', async ({ page }, info) => {
    only(info, 'lavapipe');
    await page.route(
      (u) => u.pathname === new URL(GALLERY_URL, RELEASE_URL).pathname,
      async (route) => {
        if (route.request().resourceType() !== 'document') {
          await route.continue();
          return;
        }
        const res = await route.fetch();
        const headers = { ...res.headers() };
        delete headers['cross-origin-opener-policy'];
        delete headers['cross-origin-embedder-policy'];
        await route.fulfill({ response: res, headers });
      },
    );
    await canvasLeg(page, GALLERY_URL);
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(false);
  });

  test('M10 no GPU API: Canvas 2D, no engine request', async ({ page }, info) => {
    only(info, 'lavapipe');
    await page.addInitScript(() => {
      Reflect.deleteProperty(Navigator.prototype, 'gpu');
      Reflect.deleteProperty(globalThis, 'WebGL2RenderingContext');
    });
    await canvasLeg(page, GALLERY_URL);
  });

  test('M11 no Atomics.waitAsync: Canvas 2D, no engine request', async ({ page }, info) => {
    only(info, 'lavapipe');
    await page.addInitScript(() => {
      Reflect.deleteProperty(Atomics, 'waitAsync');
    });
    await canvasLeg(page, GALLERY_URL);
  });

  test('M12 failed session: Canvas 2D, no engine request', async ({ page }, info) => {
    only(info, 'lavapipe');
    await page.addInitScript(() => {
      sessionStorage.setItem('pulsus-dash.engine-failed', '1');
    });
    await canvasLeg(page, GALLERY_URL);
  });
});

/** `npm run preview`'s path: `vite preview` with the computed manifest (plan #256 §3.5). */
test.describe('e2e:mode-matrix preview', () => {
  test.use({ baseURL: PREVIEW_URL });

  test('M13 preview default: the manifest lists the wasm; the engine draws', async ({
    page,
  }, info) => {
    only(info, 'lavapipe');
    const r = await page.request.get('/asset-manifest.json');
    expect(r.status()).toBe(200);
    expect(r.headers()['content-type']).toBe('application/json');
    const m = (await r.json()) as { files?: { path: string }[] };
    expect((m.files ?? []).some((f) => /^assets\/dash-engine-[^/]+\.wasm$/.test(f.path))).toBe(
      true,
    );
    await legOf(page, GALLERY_URL);
    await expect(page.locator('html')).toHaveAttribute('data-dash-status', '2');
    expect(await engines(page)).toEqual(lines('wasm-webgl2'));
  });

  test('M14 preview integrity: a flipped wasm byte is refused twice, then Canvas 2D', async ({
    page,
  }, info) => {
    only(info, 'lavapipe');
    const wasm = await flipWasm(page);
    const warnings = warningsOf(page);
    await legOf(page, GALLERY_URL);
    expect(await engines(page)).toEqual(all('canvas2d'));
    expect(wasm).toHaveLength(2);
    expect(warnings.some((w) => w.includes('engine_integrity_failed'))).toBe(true);
  });
});

/** The dev server (`npm run dev`) with the engine built and no `VITE_ENGINE`. */
test.describe('e2e:mode-matrix dev server', () => {
  test.use({ baseURL: DEV_URL });

  test('M15 dev server default: the engine draws', async ({ page }, info) => {
    only(info, 'lavapipe');
    // The first load transforms the modules on demand.
    test.setTimeout(120_000);
    await legOf(page, GALLERY_URL);
    await expect(page.locator('html')).toHaveAttribute('data-dash-status', '2');
    expect(await engines(page)).toEqual(lines('wasm-webgl2'));
  });
});

test.describe('e2e:mode-matrix', () => {
  test('M4 build flag: the pinned fault build is Canvas 2D, no engine request', async ({
    page,
  }, info) => {
    only(info, 'lavapipe');
    await canvasLeg(page, GALLERY_URL);
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

  test('integrity: a flipped wasm byte is refused twice, then Canvas 2D for the session', async ({
    page,
  }, info) => {
    only(info, 'lavapipe');
    const wasm = await flipWasm(page);
    const warnings = warningsOf(page);
    await legOf(page, `${ENGINE_URL}&mode=t2`);
    expect(await engines(page)).toEqual(all('canvas2d'));
    expect(wasm).toHaveLength(2);
    expect(warnings.some((w) => w.includes('engine_integrity_failed'))).toBe(true);
    // The failed boot marked the session (plan #256 §4.2): the reload makes no engine request.
    await page.unroute(/\/assets\/dash-engine-[^/]+\.wasm$/);
    const req = engineRequests(page);
    await page.reload();
    await framesReady(page);
    expect(await engines(page)).toEqual(all('canvas2d'));
    expect(req).toEqual([]);
  });
});

/** The five line pages of `canvas2d parity`. */
const PARITY_PAGES = ['line-1', 'line-50', 'line-gaps', 'line-600', 'line-extreme'] as const;

interface Shot {
  img: Rgba;
  plot: number[];
}

/** Every parity page's canvas and plot on one gallery load of `query` in `theme`, device px. */
async function frames(
  browser: Browser,
  query: string,
  theme: string,
): Promise<{ shots: Map<string, Shot>; dpr: number }> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await ctx.newPage();
    await page.addInitScript((t) => {
      localStorage.setItem('pulsus-dash.theme', t);
    }, theme);
    await open(page, `${GALLERY_URL}${query}`);
    await framesReady(page);
    const shots = new Map<string, Shot>();
    for (const id of PARITY_PAGES) {
      shots.set(id, { img: decodePng(await canvasPng(page, id)), plot: await plotRect(page, id) });
    }
    return { shots, dpr: await page.evaluate(() => devicePixelRatio) };
  } finally {
    await ctx.close();
  }
}

/** The largest channel difference at (x, y), or over its 3 × 3 neighbourhood (±1 device px). */
function diff(a: Rgba, b: Rgba, x: number, y: number, around = false): number {
  let m = 0;
  for (let dy = around ? -1 : 0; dy <= (around ? 1 : 0); dy++) {
    for (let dx = around ? -1 : 0; dx <= (around ? 1 : 0); dx++) {
      const i = ((y + dy) * a.w + (x + dx)) * 4;
      for (let k = 0; k < 3; k++) {
        m = Math.max(m, Math.abs((a.px[i + k] ?? 0) - (b.px[i + k] ?? 0)));
      }
    }
  }
  return m;
}

/**
 * The Canvas 2D line mask (the frame with and without data differs by ≥ 64 in a channel): 32
 * line points evenly in x, and 32 background points at least 4 px from the mask.
 */
function probes(withLine: Rgba, without: Rgba, plot: number[], dpr: number) {
  const [x = 0, y = 0, w = 0, h = 0] = plot.map((v) => Math.round(v * dpr));
  const mask = (px: number, py: number): boolean => diff(withLine, without, px, py) >= 64;
  const near = (px: number, py: number): boolean => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) if (mask(px + dx, py + dy)) return true;
    }
    return false;
  };
  const line: [number, number][] = [];
  const background: [number, number][] = [];
  for (let k = 0; k < 32; k++) {
    const px = x + 4 + Math.floor(((w - 8) * (k + 0.5)) / 32);
    const ys: number[] = [];
    for (let py = y + 1; py < y + h - 1; py++) if (mask(px, py)) ys.push(py);
    const mid = ys[ys.length >> 1];
    if (mid !== undefined) line.push([px, mid]);
    for (let j = 0; j < h - 8; j++) {
      const py = y + 4 + ((j * 37 + k * 13) % Math.max(1, h - 8));
      if (!near(px, py)) {
        background.push([px, py]);
        break;
      }
    }
  }
  return { line, background };
}

const count = (a: Rgba, b: Rgba, pts: [number, number][], around: boolean): number =>
  pts.filter(([x, y]) => diff(a, b, x, y, around) >= 64).length;

/**
 * `canvas2d parity` (plan #68 C1 §5; VIZ-001): sampled geometric parity with Canvas 2D. The
 * engine's plot rects equal Canvas 2D's, and the engine draws a line where Canvas 2D does (the
 * sampled line mask, ±1 device px); anti-aliasing differs by design, so pixel identity is gated
 * against the native renderer instead (`golden:engine-line`). Negative: `noline` (no line drawn)
 * must fail the mask.
 */
test.describe('canvas2d parity (VIZ-001)', () => {
  for (const theme of ['dark', 'light'] as const) {
    test(`sampled geometric parity with Canvas 2D (${theme})`, async ({ browser }, info) => {
      test.setTimeout(180_000);
      const tier = tierOf(info);
      await leg(info, async () => {
        const c2 = await frames(browser, '&engine=canvas2d', theme);
        const c2e = await frames(browser, '&engine=canvas2d&fault=empty', theme);
        const wa = await frames(browser, tier.query, theme);
        const wae = await frames(browser, `${tier.query}&fault=empty`, theme);
        const get = (f: { shots: Map<string, Shot> }, id: string): Shot => {
          const s = f.shots.get(id);
          if (s === undefined) throw new Error(`${id}: no shot`);
          return s;
        };
        for (const id of PARITY_PAGES) {
          const [a, ae, w, we] = [c2, c2e, wa, wae].map((f) => get(f, id));
          if (a === undefined || ae === undefined || w === undefined || we === undefined) {
            throw new Error(id);
          }
          expect(w.plot, `${id} ${theme}: data-plot`).toEqual(a.plot);
          const p = probes(a.img, ae.img, a.plot, c2.dpr);
          expect([p.line.length, p.background.length], `${id} ${theme}: probes`).toEqual([32, 32]);
          expect(count(w.img, we.img, p.line, true), `${id} ${theme}: line`).toBeGreaterThanOrEqual(
            28,
          );
          expect(
            count(w.img, we.img, p.background, false),
            `${id} ${theme}: background`,
          ).toBeLessThanOrEqual(8);
        }
        if (theme !== 'dark') return;
        // The negative: with no line drawn the same check fails.
        const id = 'line-1';
        const n = get(await frames(browser, `${tier.query}&fault=noline`, theme), id);
        const p = probes(get(c2, id).img, get(c2e, id).img, get(c2, id).plot, c2.dpr);
        expect(count(n.img, get(wae, id).img, p.line, true), 'noline').toBeLessThan(28);
      });
    });
  }
});
