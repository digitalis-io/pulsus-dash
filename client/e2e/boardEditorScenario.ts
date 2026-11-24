/**
 * The scripted board-editor interactions (#90, plan Appendix B §B.5): Edit board, then three rounds
 * of open the panel editor, title, language, query, visualisation and Done. Document 4 of
 * `bench:inp-rooms` and the scenario of `bench:rooms-long-tasks`.
 */
import { expect, type Page } from '@playwright/test';

/**
 * Clicks and key presses of `boardEditorScenario` (1 + 3 × 16): Shift+Enter is two interactions
 * (Shift, then Enter).
 */
export const EDITOR_SCENARIO_N = 49;

export type Step = (label: string, count: number, act: () => Promise<void>) => Promise<void>;

const LANGS = ['LogQL', 'PromQL', 'LogQL'] as const;
const KINDS = ['Bars', 'Heatmap', 'Stat'] as const;

/** On `/t/demo/board/b-1` in View mode, with its on-screen chart frames ready. */
export async function boardEditorScenario(page: Page, step: Step): Promise<void> {
  const d = page.getByRole('dialog', { name: 'Edit panel' });
  await step('editor edit board', 1, async () => {
    await page.getByRole('button', { name: 'Edit board' }).click();
    await expect(page.locator('[data-drag-handle]')).toHaveCount(4);
  });
  for (let i = 0; i < 3; i++) {
    await step('editor open', 2, async () => {
      await page.getByRole('button', { name: /^Panel menu: Request rate/ }).click();
      await page.getByRole('menuitem', { name: 'Edit panel' }).click();
      await d.waitFor();
      // A drawn chart, or the panel's message: a LogQL panel's answer may not draw (#67), and a
      // Heatmap of Request rate has no buckets (plan #64).
      await d
        .getByRole('region', { name: 'Preview' })
        .locator('[data-chart-frame][data-frame-ready="true"], [data-preview-host] > p')
        .first()
        .waitFor();
    });
    await step('editor title', 4, async () => {
      await d.getByRole('textbox', { name: 'Title' }).click();
      await page.keyboard.press('End');
      await page.keyboard.type('XY');
    });
    await step('editor lang', 2, async () => {
      await d.getByRole('button', { name: /Query language$/ }).click();
      await page.getByRole('option', { name: LANGS[i] ?? 'PromQL', exact: true }).click();
    });
    await step('editor query', 5, async () => {
      // The PromQL editor (plan #64 A.5) or the LogQL editor (#67). Shift+Enter runs.
      await d.getByRole('textbox', { name: 'Query' }).click();
      await page.keyboard.press('End');
      await page.keyboard.type('x');
      await page.keyboard.press('Shift+Enter');
    });
    await step('editor vis', 2, async () => {
      await d.getByRole('button', { name: /Visualisation$/ }).click();
      await page.getByRole('option', { name: KINDS[i] ?? 'Line', exact: true }).click();
    });
    await step('editor done', 1, async () => {
      await d.getByRole('button', { name: 'Done' }).click();
      await expect(d).toBeHidden();
    });
  }
}
