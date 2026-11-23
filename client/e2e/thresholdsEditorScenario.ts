/**
 * The "board editor, 8 thresholds" scenario of `bench:rooms-long-tasks` (plan #64 Part B B.10): Edit
 * board, add thresholds to Request rate up to 8, reopen the editor on the 8-step panel and edit the
 * last step's value, state and label. 17 clicks and 8 key presses.
 */
import { expect, type Page } from '@playwright/test';
import type { Step } from './boardEditorScenario.ts';

/** On `/t/demo/board/b-1` in View mode, with its on-screen chart frames ready. */
export async function thresholdsEditorScenario(page: Page, step: Step): Promise<void> {
  const d = page.getByRole('dialog', { name: 'Edit panel' });
  const openEditor = async (): Promise<void> => {
    await page.getByRole('button', { name: /^Panel menu: Request rate/ }).click();
    await page.getByRole('menuitem', { name: 'Edit panel' }).click();
    await d.waitFor();
  };
  await step('thresholds edit board', 1, async () => {
    await page.getByRole('button', { name: 'Edit board' }).click();
    await expect(page.locator('.react-grid-item')).toHaveCount(4);
  });
  await step('thresholds add', 9, async () => {
    await openEditor();
    // The stub's Request rate has two thresholds (B.9): six more make 8.
    const add = d.getByRole('button', { name: 'Add threshold' });
    for (let i = 0; i < 6; i++) await add.click();
    await expect(d.getByRole('textbox', { name: 'Value' })).toHaveCount(8);
    await expect(add).toBeDisabled();
    await d.getByRole('button', { name: 'Done' }).click();
    await expect(d).toBeHidden();
  });
  await step('thresholds editor reopen', 2, async () => {
    await openEditor();
    await expect(d.getByRole('textbox', { name: 'Value' })).toHaveCount(8);
  });
  await step('thresholds value', 6, async () => {
    await d.getByRole('textbox', { name: 'Value' }).nth(7).click();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('9999');
  });
  await step('thresholds state', 2, async () => {
    await d
      .getByRole('button', { name: /State$/ })
      .nth(7)
      .click();
    await page.getByRole('option', { name: 'Failing', exact: true }).click();
  });
  await step('thresholds label', 4, async () => {
    await d.getByRole('textbox', { name: 'Label' }).nth(7).click();
    await page.keyboard.type('cap');
  });
  await step('thresholds done', 1, async () => {
    await d.getByRole('button', { name: 'Done' }).click();
    await expect(d).toBeHidden();
  });
}
