/**
 * `e2e:engine-recovery` (plan #68 C1 §5, T03 §9.2) on the fault build, in both projects on their
 * tier: a frame failure moves that frame to Canvas 2D on a fresh canvas with a notice; one trap
 * after a draw restarts the engine on the same tier; traps on every draw end the engine for the
 * session.
 */
import { expect, test } from '@playwright/test';
import { frame, GALLERY_URL, open, waitReady } from './helpers.ts';
import {
  canvasShot,
  compareShots,
  engines,
  framesReady,
  leg,
  LINE_IDS,
  liveCanvas,
  NOTICE,
  plotRect,
  tierOf,
} from './engine.ts';

test.describe('e2e:engine-recovery', () => {
  test('surface: the first line frame falls back alone', async ({ page, browser }, info) => {
    const tier = tierOf(info);
    await leg(info, async () => {
      await open(page, `${GALLERY_URL}${tier.query}&fault=surface`);
      await framesReady(page);
      const f = frame(page, 'line-1');
      await expect(liveCanvas(page, 'line-1')).toHaveAttribute('data-engine', 'canvas2d');
      await expect(f.locator('[data-engine-notice]')).toHaveText(NOTICE);
      const retired = f.locator('canvas[data-retired]');
      await expect(retired).toHaveCount(1);
      expect(await retired.evaluate((c) => getComputedStyle(c).display)).toBe('none');
      // The other line frames stay on the engine.
      await expect(liveCanvas(page, 'line-50')).toHaveAttribute('data-engine', tier.engine);
      // The fallback draws what Canvas 2D draws.
      const got = await canvasShot(page, 'line-1', info, 'surface-line-1');
      const ref = await browser.newPage();
      try {
        await open(ref, GALLERY_URL);
        await framesReady(ref);
        const want = await canvasShot(ref, 'line-1', info, 'surface-line-1-canvas2d');
        const plot = await plotRect(ref, 'line-1');
        // The mean only: the notice lies over the fallback's plot (plan: ≤ 0.005).
        const dpr = await ref.evaluate(() => devicePixelRatio);
        const r = compareShots(want, got, plot, dpr, { tileMax: false });
        expect(r.code, r.out).toBe(0);
      } finally {
        await ref.close();
      }
    });
  });

  test('trap: one restart after the first draw, on the same tier', async ({ page }, info) => {
    const tier = tierOf(info);
    await leg(info, async () => {
      await open(page, `${GALLERY_URL}${tier.query}&fault=trap`);
      await framesReady(page);
      for (const id of LINE_IDS) {
        await expect(liveCanvas(page, id)).toHaveAttribute('data-engine', tier.engine);
        await expect(frame(page, id).locator('[data-engine-notice]')).toHaveText(NOTICE);
      }
      await expect(page.locator('html')).toHaveAttribute('data-dash-status', tier.status);
      expect(await page.evaluate(() => sessionStorage.getItem('pulsus-dash.engine-failed'))).toBe(
        null,
      );
    });
  });

  test('trap2: every engine frame falls back, also after a reload', async ({ page }, info) => {
    const tier = tierOf(info);
    await leg(info, async () => {
      const url = `${GALLERY_URL}${tier.query}&fault=trap2`;
      await open(page, url);
      for (const id of LINE_IDS) {
        await expect(liveCanvas(page, id)).toHaveAttribute('data-engine', 'canvas2d');
      }
      await framesReady(page);
      expect(await page.evaluate(() => sessionStorage.getItem('pulsus-dash.engine-failed'))).toBe(
        '1',
      );
      await page.reload();
      await waitReady(page, url);
      await framesReady(page);
      expect(Object.values(await engines(page)).every((e) => e === 'canvas2d')).toBe(true);
    });
  });
});
