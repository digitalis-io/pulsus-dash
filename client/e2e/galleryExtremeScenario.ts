/**
 * The gallery near-limit scenario (#97 plan §4.6): 20 wheel steps (time zoom) at the centre of the
 * `line-extreme` plot, values over [−MAX, MAX], each followed by one animation frame, then the
 * frame's redraw. The fourth scenario of `bench:rooms-long-tasks`. The value band is avoided:
 * value gestures on an overflowing domain are out of scope (plan §8 R4).
 */
import { expect, type Page } from '@playwright/test';
import type { Step } from './boardEditorScenario.ts';
import { frame, plotOf } from './helpers.ts';

/** On the gallery (`GALLERY_URL`) after `galleryReady`. */
export async function galleryExtremeScenario(page: Page, step: Step): Promise<void> {
  const f = frame(page, 'line-extreme');
  await f.scrollIntoViewIfNeeded();
  const plot = await plotOf(f);
  const b = await f.boundingBox();
  if (b === null) throw new Error('line-extreme has no box');
  const x = Math.round(b.x + plot.x + plot.width / 2);
  const y = Math.round(b.y + plot.y + plot.height / 2);
  await step('gallery near-limit wheel', 0, async () => {
    await page.mouse.move(x, y);
    for (let i = 0; i < 20; i++) {
      await page.mouse.wheel(0, -100);
      await page.evaluate(
        () =>
          new Promise<void>((r) => {
            requestAnimationFrame(() => {
              r();
            });
          }),
      );
    }
    await expect(f).toHaveAttribute('data-frame-ready', 'true');
  });
}
