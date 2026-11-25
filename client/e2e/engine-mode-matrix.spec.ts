/**
 * `e2e:mode-matrix` (plan #68 C1 §5; VIZ-001, T03-025, PRF-009): each engine mode on the gallery.
 * Chromium on lavapipe (playwright.engine.config.ts). Every leg draws `line-50` with ink in its
 * plot, whatever engine drew it.
 */
import { expect, test, type Page } from '@playwright/test';
import { GALLERY_IDS, GALLERY_URL, open } from './helpers.ts';
import { ENGINE_URL, engineRequests, engines, framesReady, LINE_IDS, plotInk } from './engine.ts';

const all = (kind: string): Record<string, string> =>
  Object.fromEntries(GALLERY_IDS.map((id) => [id, kind]));
const lines = (kind: string): Record<string, string> =>
  Object.fromEntries(
    GALLERY_IDS.map((id) => [id, (LINE_IDS as readonly string[]).includes(id) ? kind : 'canvas2d']),
  );

async function leg(page: Page, url: string): Promise<void> {
  await open(page, url);
  await framesReady(page);
  expect(await plotInk(page, 'line-50')).toBeGreaterThan(1000);
}

test.describe('e2e:mode-matrix', () => {
  test('default: Canvas 2D, no engine request', async ({ page }) => {
    const req = engineRequests(page);
    await leg(page, GALLERY_URL);
    expect(await engines(page)).toEqual(all('canvas2d'));
    expect(req).toEqual([]);
  });

  test('webgpu: status 1 on lavapipe', async ({ page }) => {
    await leg(page, ENGINE_URL);
    const html = page.locator('html');
    await expect(html).toHaveAttribute('data-dash-status', '1');
    await expect(html).toHaveAttribute('data-dash-mode', 'mt');
    await expect(html).toHaveAttribute('data-dash-adapter', /llvmpipe/i);
    expect(await engines(page)).toEqual(lines('wasm-webgpu'));
  });

  test('webgl2: mode=t2 is status 2', async ({ page }) => {
    await leg(page, `${ENGINE_URL}&mode=t2`);
    await expect(page.locator('html')).toHaveAttribute('data-dash-status', '2');
    expect(await engines(page)).toEqual(lines('wasm-webgl2'));
  });

  test('no-offscreen: Canvas 2D, no engine request', async ({ page }) => {
    await page.addInitScript(() => {
      Reflect.deleteProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen');
    });
    const req = engineRequests(page);
    await leg(page, ENGINE_URL);
    expect(await engines(page)).toEqual(all('canvas2d'));
    expect(req).toEqual([]);
  });

  test('static: Canvas 2D', async ({ page }) => {
    await leg(page, `${ENGINE_URL}&mode=static`);
    expect(await engines(page)).toEqual(all('canvas2d'));
  });

  test('integrity: a flipped wasm byte is refused twice, then Canvas 2D', async ({ page }) => {
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
    await leg(page, ENGINE_URL);
    expect(await engines(page)).toEqual(all('canvas2d'));
    expect(wasm).toHaveLength(2);
    expect(warnings.some((w) => w.includes('engine_integrity_failed'))).toBe(true);
  });
});
