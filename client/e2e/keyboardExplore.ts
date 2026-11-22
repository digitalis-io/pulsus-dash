/**
 * Keyboard loop L32 (plan #63 Part C Appendix C.7): the Explore metrics page with a result — the
 * editor's Run keys and Escape, the crosshair, the rate chip, the table's sort buttons, rows and
 * region, the vis options and the metric picker — and with a query the server refuses (plan #112). Run inside the one keyboard test, so the final
 * coverage check covers it.
 */
import { expect, test } from '@playwright/test';
import { EXPLORE_RESULT } from './helpers.ts';
import type { Script } from './keyboardScript.ts';

const ROW = (i: number): RegExp => new RegExp(`^button "stub_metric\\{series="${String(i)}"\\}"$`);
const REGION = 'region "Series. Choose a series to show it alone; choose it again to show all."';

export async function exploreLoops(s: Script): Promise<void> {
  const { page, h } = s;
  const { press } = h;
  await test.step('L32 Explore metrics', async () => {
    await s.goto(EXPLORE_RESULT);
    const table = page.getByRole('table');
    await expect(table.getByRole('row')).toHaveCount(4);

    await s.focus('textbox "PromQL query"');
    await press('End');
    await press('Shift+Enter');
    await press('Escape');
    await expect(page.getByRole('button', { name: 'Run' })).toBeFocused();
    await s.on('button "Run"');

    await s.on('slider "Crosshair: Query result"', 'ArrowRight');

    await s.on('button "Rate applied"', 'Space');
    await s.on('button "Rate applied"', 'Space');
    await expect.poll(() => s.search()['rate']).toBeUndefined();

    await s.on('button "Series"');
    await s.on('button "Last"');
    await s.on('button "Max"');

    for (const i of [0, 1, 2]) {
      await s.on(ROW(i));
      await press('Enter');
    }

    await s.focus(REGION);

    await s.focus('radio "Auto (Line)"');
    for (let i = 0; i < 4; i++) {
      await press('Space');
      await press('ArrowRight');
    }
    await press('Space');
    // Back to Auto with the arrows: React Aria's toolbar keys are the arrows only (no Home).
    for (let i = 0; i < 4; i++) await press('ArrowLeft');
    await press('Space');
    await expect.poll(() => s.search()['vis']).toBeUndefined();

    for (let i = 0; i < 5; i++) {
      await s.focus('combobox "Metric"');
      // The list opens on focus; once, close it so the combobox itself is operated (ArrowDown
      // reopens the list on its first option).
      if (i === 0) await press('Escape');
      for (let k = 0; k <= i; k++) await press('ArrowDown');
      await press('Enter');
    }
    // Tab from the open list releases the inert page and moves on to Run (C.11.1).
    await s.focus('combobox "Metric"');
    await press('Tab');
    await expect(page.getByRole('button', { name: 'Run' })).toBeFocused();
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await expect(page.locator('[inert]')).toHaveCount(0);

    // A query refused before it runs (Explore has no variables, plan #112 §10 Q1; a templated
    // panel opened in Explore, L24, gives the same): the error, and the vis options without a
    // result.
    await s.goto(
      `/t/demo/explore/metrics?from=now-1h&to=now&refresh=off&q=${encodeURIComponent('up{r="$r"}')}`,
    );
    await expect(page.getByRole('alert')).toContainText('no value for variable $r');
    await s.on('radio "Auto"', 'Space');

    await s.goto('/t/demo/explore/metrics');
  });
}
