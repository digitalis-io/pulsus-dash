/**
 * The scripted chart gestures (#93, plan Appendix A §A.3): wheel, pinch, value zoom and its reset,
 * pan, box zoom and double-click on the `Request rate` panel of `/t/demo/board/b-1`. Document 5 of
 * `bench:inp-rooms` and the second scenario of `bench:rooms-long-tasks`.
 */
import { expect, type Page } from '@playwright/test';
import { plotOf } from './helpers.ts';

/** Clicks, key presses and drags of `chartGestureScenario` (upper bounds, see the table). */
export const CHART_SCENARIO_N = 14;

export type Step = (label: string, count: number, act: () => Promise<void>) => Promise<void>;

/** On `/t/demo/board/b-1` in View mode with its on-screen chart frames ready; gestures on `Request rate`. */
export async function chartGestureScenario(page: Page, step: Step): Promise<void> {
  const f = page.locator('[data-chart-frame]', {
    has: page.getByRole('slider', { name: 'Crosshair: Request rate', exact: true }),
  });
  const plot = await plotOf(f);
  const centre = async (): Promise<{ x: number; y: number }> => {
    const b = await f.boundingBox();
    if (b === null) throw new Error('Request rate has no box');
    return {
      x: Math.round(b.x + plot.x + plot.width / 2),
      y: Math.round(b.y + plot.y + plot.height / 2),
    };
  };
  /** Waits for the URL to change from `before`, then for the frame to be drawn. */
  const commit = async (before: string): Promise<void> => {
    await expect.poll(() => page.url()).not.toBe(before);
    await expect(f).toHaveAttribute('data-frame-ready', 'true');
  };
  const reset = page.getByRole('button', { name: 'Reset Y axis: Request rate' });

  await step('chart wheel', 0, async () => {
    for (const d of [-100, 100, -100]) {
      const c = await centre();
      await page.mouse.move(c.x, c.y);
      const before = page.url();
      await page.keyboard.down('Control');
      for (let i = 0; i < 10; i++) {
        await page.mouse.wheel(0, d);
        await page.waitForTimeout(16);
      }
      await page.keyboard.up('Control');
      await commit(before);
    }
  });
  await step('chart pinch', 1, async () => {
    const before = page.url();
    await page.keyboard.down('Control');
    for (let i = 0; i < 8; i++) {
      await page.mouse.wheel(0, -2.5);
      await page.waitForTimeout(16);
    }
    await page.keyboard.up('Control');
    await commit(before);
  });
  await step('chart value zoom', 1, async () => {
    await page.keyboard.down('Control');
    await page.keyboard.down('Shift');
    for (let i = 0; i < 8; i++) await page.mouse.wheel(0, -100);
    await page.keyboard.up('Shift');
    await page.keyboard.up('Control');
    await reset.waitFor();
  });
  await step('chart reset', 1, async () => {
    await reset.click();
    await expect(reset).toBeHidden();
  });
  await step('chart pan', 3, async () => {
    for (const dx of [150, -150, 150]) {
      const c = await centre();
      const before = page.url();
      await page.mouse.move(c.x, c.y);
      await page.mouse.down();
      await page.mouse.move(c.x + dx, c.y, { steps: 10 });
      await page.mouse.up();
      await commit(before);
    }
  });
  await step('chart box', 6, async () => {
    for (let i = 0; i < 3; i++) {
      const c = await centre();
      const before = page.url();
      await page.mouse.move(c.x - 60, c.y);
      await page.mouse.down({ button: 'right' });
      await page.mouse.move(c.x + 60, c.y, { steps: 10 });
      await page.mouse.up({ button: 'right' });
      await commit(before);
    }
  });
  await step('chart double-click', 2, async () => {
    const c = await centre();
    const before = page.url();
    await page.mouse.dblclick(c.x, c.y);
    await commit(before);
  });
}
