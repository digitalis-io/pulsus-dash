/**
 * The Inspector's controls by keyboard (T25, #192), shared by L35 (a board) and L32 (Explore ›
 * Metrics). A drain cannot re-open the sheet (it is not an overlay, so a fresh entry of the route
 * has none), so every control of the sheet is operated here, each with what it does: the copies,
 * the disabled pivots and actions (nothing happens), Collapse and Expand, the Explore pivot (boards
 * only), Edit query, Close (focus returns to the opener) and the Esc ladder.
 */
import { expect, type Locator } from '@playwright/test';
import type { Script } from './keyboardScript.ts';

export interface SheetSteps {
  /** Opens the sheet by keyboard from `opener` (its heading takes focus). */
  readonly open: () => Promise<void>;
  /** The control that opened it: focus returns there on Close. */
  readonly opener: Locator;
  /** The query `Copy query` copies. */
  readonly query: string;
  /** A frame that shows the selection (`data-selection-keys`). */
  readonly frame: Locator;
  /** After Edit query: asserts what it did and leaves the page as `open` expects it. */
  readonly afterEdit: () => Promise<void>;
  /** Boards only: operates the Explore pivot and asserts the navigation. */
  readonly explore?: () => Promise<void>;
}

/** The pivots and actions that are disabled for the stub's series (no service_name or job). */
const DISABLED = [
  'link "Logs ±1 min"',
  'link "Traces"',
  'link "Profiles"',
  'link "Entity"',
  'link "Label filter"',
  'button "Pin"',
  'button "Create alert"',
  'button "Ask AI ✦"',
] as const;

export async function inspectorSheet(s: Script, o: SheetSteps): Promise<void> {
  const { page, h } = s;
  const { press } = h;
  const sheet = page.locator('[data-inspector]:not([data-closing])');
  const copied = () => page.evaluate(() => window.__copied.at(-1) ?? '');
  await o.open();
  const path = s.path();
  await s.on('button "Copy value"');
  await expect.poll(copied).toMatch(/^[\d.e+-]+$/);
  await s.on('button "Copy query"');
  await expect.poll(copied).toBe(o.query);
  for (const key of DISABLED) {
    await s.on(key);
    await expect(sheet).toBeVisible();
    expect(s.path()).toBe(path);
  }
  await s.on('button "Collapse Inspector"');
  await expect(sheet).toHaveAttribute('data-collapsed', '');
  await s.on('button "Expand Inspector"');
  await expect(sheet).not.toHaveAttribute('data-collapsed');
  await expect(sheet.getByRole('button', { name: 'Collapse Inspector' })).toBeFocused();
  if (o.explore !== undefined) {
    await o.explore();
    await o.open();
  }
  await s.on('button "Edit query"');
  await o.afterEdit();
  await o.open();
  await s.on('button "Close Inspector"');
  await expect(sheet).toHaveCount(0);
  await expect(o.opener).toBeFocused();
  // The Esc ladder: the selection first, then the Inspector.
  await o.open();
  await expect(o.frame).not.toHaveAttribute('data-selection-keys', '');
  await press('Escape');
  await expect(o.frame).toHaveAttribute('data-selection-keys', '');
  await expect(sheet).toBeVisible();
  await press('Escape');
  await expect(sheet).toHaveCount(0);
}
