import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  ALL_PAGES,
  frame,
  GALLERY_URL,
  galleryReady,
  open,
  openPicker,
  openUserMenu,
  SHELL_PAGES,
} from './helpers.ts';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function seriousViolations(page: Page): Promise<string[]> {
  const r = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return r.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

async function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const sel =
      'a, button, input, [role^=menuitem], [role=checkbox], [role=option], [role=gridcell] button, [role=gridcell] [role=button]';
    const out: string[] = [];
    // Screen-reader-only content (React Aria's VisuallyHidden: clip-path inset(50%)) is not a target.
    const visuallyHidden = (el: Element): boolean => {
      for (let e: Element | null = el; e !== null; e = e.parentElement) {
        const s = getComputedStyle(e);
        if (s.clipPath === 'inset(50%)') return true;
      }
      return false;
    };
    for (const el of document.querySelectorAll<HTMLElement>(sel)) {
      if (visuallyHidden(el)) continue;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      const visible =
        r.width > 0 &&
        r.height > 0 &&
        s.visibility !== 'hidden' &&
        el.closest('[aria-hidden="true"]') === null;
      if (!visible || el.closest('[data-outside-month]') !== null) continue;
      if (r.width < 24 || r.height < 24) {
        out.push(
          `${el.tagName.toLowerCase()} "${el.getAttribute('aria-label') ?? el.textContent}" ${String(Math.round(r.width))}×${String(Math.round(r.height))}`,
        );
      }
    }
    return out;
  });
}

test.describe('e2e:a11y-rooms axe', () => {
  for (const theme of ['dark', 'light'] as const) {
    for (const url of ALL_PAGES) {
      test(`${theme} ${url}`, async ({ page }) => {
        await page.addInitScript((t) => {
          localStorage.setItem('pulsus-dash.theme', t);
        }, theme);
        await open(page, url);
        expect(await seriousViolations(page)).toEqual([]);
      });
    }
  }

  test('dark, picker and user menu open', async ({ page }) => {
    await open(page, '/t/demo/boards');
    await openPicker(page);
    expect(await seriousViolations(page)).toEqual([]);
    await page.keyboard.press('Escape');
    await openUserMenu(page);
    expect(await seriousViolations(page)).toEqual([]);
  });
});

/** The board states of plan #61 Part B §5.3, in order; `check` runs in each. */
async function boardStates(page: Page, check: (state: string) => Promise<void>): Promise<void> {
  await open(page, '/t/demo/boards');
  await page.getByRole('button', { name: 'New board' }).click();
  await page.getByRole('dialog', { name: 'New board' }).waitFor();
  await check('boards, New board dialog');
  await page.keyboard.press('Escape');

  await open(page, '/t/demo/board/b-1');
  await expect(page.locator('[data-chart-frame][data-frame-ready="true"]')).toHaveCount(3);
  await check('b-1 view');
  await page.getByRole('button', { name: 'Edit board' }).click();
  await page.getByRole('button', { name: 'Panel menu: Request rate' }).click();
  await page.getByRole('menuitem', { name: 'Edit panel' }).click();
  const editor = page.getByRole('complementary', { name: 'Panel editor' });
  await editor.waitFor();
  await check('b-1 edit, editor open');
  await editor.getByRole('button', { name: /Visualisation$/ }).click();
  await page.getByRole('listbox').waitFor();
  await check('b-1 edit, select open');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Add panel' }).click();
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Boards', exact: true })
    .click();
  await page.getByRole('dialog', { name: 'Discard unsaved changes?' }).waitFor();
  await check('b-1 guard dialog');
}

test.describe('e2e:a11y-rooms boards', () => {
  for (const theme of ['dark', 'light'] as const) {
    test(`${theme} board list and board states`, async ({ page }) => {
      await page.addInitScript((t) => {
        localStorage.setItem('pulsus-dash.theme', t);
      }, theme);
      await boardStates(page, async (state) => {
        expect(await seriousViolations(page), state).toEqual([]);
      });
    });
  }

  test('board targets are at least 24 × 24 px', async ({ page }) => {
    await boardStates(page, async (state) => {
      expect(await smallTargets(page), state).toEqual([]);
    });
  });
});

test.describe('e2e:a11y-rooms target size', () => {
  test('every visible target is at least 24 × 24 px', async ({ page }) => {
    for (const url of ALL_PAGES) {
      await open(page, url);
      expect(await smallTargets(page), url).toEqual([]);
      if ((SHELL_PAGES as readonly string[]).includes(url)) {
        const dialog = await openPicker(page);
        await dialog.getByRole('grid').waitFor();
        expect(await smallTargets(page), `${url} picker`).toEqual([]);
        await page.keyboard.press('Escape');
        await openUserMenu(page);
        expect(await smallTargets(page), `${url} user menu`).toEqual([]);
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: /Switch tenant/ }).click();
        expect(await smallTargets(page), `${url} tenant menu`).toEqual([]);
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: /Auto-refresh interval/ }).click();
        expect(await smallTargets(page), `${url} refresh menu`).toEqual([]);
        await page.keyboard.press('Escape');
      }
    }
  });
});

test.describe('e2e:a11y-rooms gallery', () => {
  test('gallery canvases expose their summary', async ({ page }) => {
    await open(page, GALLERY_URL);
    await galleryReady(page);
    await expect(page.locator('canvas[role="img"]')).toHaveCount(7);
    const label = (id: string) => frame(page, id).locator('canvas').getAttribute('aria-label');
    const range = '12:00 – 13:00 GMT';
    expect(await label('line-50')).toMatch(
      new RegExp(
        `^Request latency, 50 series × 1 440 points: line chart, 50 series, ${range}\\. Min [\\d.]+ ms, max [\\d.]+ ms, last [\\d.]+ ms\\.$`,
      ),
    );
    expect(await label('stat')).toBe(
      `p99 latency: stat, 1 series, ${range}. Min 2.84 s, max 2.84 s, last 2.84 s.`,
    );
    expect(await label('heatmap')).toMatch(
      new RegExp(
        `^Request latency distribution: heatmap, 12 buckets, ${range}\\. Min .+, max .+, last .+\\.$`,
      ),
    );
    expect(await label('bars')).toMatch(
      new RegExp(
        `^Log volume by level: stacked bar chart, 5 series, ${range}\\. Min .+, max .+, last .+\\.$`,
      ),
    );
    await expect(frame(page, 'line-600').getByRole('status')).toHaveText(
      'Showing 500 of 600 series',
    );
  });
});
