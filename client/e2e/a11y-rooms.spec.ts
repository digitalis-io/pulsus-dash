import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  ALL_PAGES,
  EXPLORE_RESULT,
  frame,
  GALLERY_URL,
  galleryReady,
  open,
  openPicker,
  openUserMenu,
  SHELL_PAGES,
} from './helpers.ts';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/**
 * Rules not run in one engine and state, with the reason. Firefox's page crashes inside axe's
 * `label` rule once a kit text field has been typed into or focused by the pointer (reproduced
 * with the panel editor's Title and the filter dialog's Label as well); Chromium and WebKit run
 * every rule in these states.
 */
const ENGINE_SKIPS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  firefox: { 'b-1 edit with sections': ['label'], 'b-1 add filter with error': ['label'] },
};

async function seriousViolations(page: Page, state = ''): Promise<string[]> {
  const engine = page.context().browser()?.browserType().name() ?? '';
  const skip = ENGINE_SKIPS[engine]?.[state] ?? [];
  const r = await new AxeBuilder({ page })
    .withTags(TAGS)
    .disableRules([...skip])
    .analyze();
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

/**
 * The board states of plan #61 Part B §5.3; `check` runs in each. Each state is entered afresh:
 * Firefox's page crashes on a pointer click after an axe run in the same page.
 */
async function boardStates(page: Page, check: (state: string) => Promise<void>): Promise<void> {
  await open(page, '/t/demo/boards');
  await page.getByRole('button', { name: 'New board' }).click();
  await page.getByRole('dialog', { name: 'New board' }).waitFor();
  await check('boards, New board dialog');

  await open(page, '/t/demo/board/b-1');
  await expect(page.locator('[data-chart-frame][data-frame-ready="true"]')).toHaveCount(3);
  await check('b-1 view');

  const editor = page.getByRole('complementary', { name: 'Panel editor' });
  const edit = async (): Promise<void> => {
    await open(page, '/t/demo/board/b-1');
    await page.getByRole('button', { name: 'Edit board' }).click();
    // The Edit grid is a lazy chunk; its panels replace the View grid's once it has loaded.
    await expect(page.locator('.react-grid-item')).toHaveCount(4);
    await page.getByRole('button', { name: 'Panel menu: Request rate' }).click();
    await page.getByRole('menuitem', { name: 'Edit panel' }).click();
    await editor.waitFor();
  };
  await edit();
  await check('b-1 edit, editor open');

  await edit();
  await editor.getByRole('button', { name: /Visualisation$/ }).click();
  await page.getByRole('listbox').waitFor();
  await check('b-1 edit, select open');

  await edit();
  await page.getByRole('button', { name: 'Add panel', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Boards', exact: true })
    .click();
  await page.getByRole('dialog', { name: 'Discard unsaved changes?' }).waitFor();
  await check('b-1 guard dialog');

  // Plan #61 Part C, Appendix C-A §A.3.
  await open(page, '/t/demo/board/b-1');
  await page.getByRole('button', { name: 'Latency', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Latency', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await check('b-1 section collapsed');

  await open(page, '/t/demo/board/b-1');
  await page.getByRole('button', { name: 'Edit board' }).click();
  await expect(page.locator('.react-grid-item')).toHaveCount(4);
  await page.getByRole('button', { name: 'Add section' }).click();
  await page.getByRole('textbox', { name: 'Section 2 title' }).waitFor();
  await check('b-1 edit with sections');

  await open(page, '/t/demo/board/b-3');
  await page.getByRole('button', { name: 'Variable region: not set' }).click();
  await page.getByRole('dialog', { name: 'Variable region' }).waitFor();
  await check('b-3 variable dialog');

  await open(page, '/t/demo/board/b-1');
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  const add = page.getByRole('dialog', { name: 'Add filter' });
  await add.getByRole('textbox', { name: 'Label' }).fill('9x');
  await add.getByRole('button', { name: 'Add' }).click();
  await add.getByText(/^Use a label name: /).waitFor();
  await check('b-1 add filter with error');

  await open(
    page,
    '/t/demo/board/b-3?from=now-1h&to=now&refresh=off&f=service%3Dcheckout&var-env=prod',
  );
  await page.getByRole('button', { name: 'Filter service: checkout' }).waitFor();
  await check('b-3 chips set');

  // A failed star: the stub's test hook fails the next star change (`pulsus-dash.stub.failStar`).
  await open(page, '/t/demo/board/b-1');
  await page.evaluate(() => {
    localStorage.setItem('pulsus-dash.stub.failStar', '1');
  });
  await page.getByRole('button', { name: 'Star board' }).click();
  await page.getByText('Could not update Starred. Try again.').waitFor();
  await check('b-1 star failed');
}

test.describe('e2e:a11y-rooms boards', () => {
  for (const theme of ['dark', 'light'] as const) {
    test(`${theme} board list and board states`, async ({ page }) => {
      test.setTimeout(120_000);
      await page.addInitScript((t) => {
        localStorage.setItem('pulsus-dash.theme', t);
      }, theme);
      await boardStates(page, async (state) => {
        expect(await seriousViolations(page, state), state).toEqual([]);
      });
    });
  }

  test('board targets are at least 24 × 24 px', async ({ page }) => {
    test.setTimeout(120_000);
    await boardStates(page, async (state) => {
      expect(await smallTargets(page), state).toEqual([]);
    });
  });
});

/** Explore with a result: the page, the editor, its completion popup and the metric picker (C.7). */
async function exploreResult(page: Page): Promise<void> {
  await open(page, EXPLORE_RESULT);
  await expect(page.getByRole('table').getByRole('row')).toHaveCount(4);
}

test.describe('e2e:a11y-rooms explore', () => {
  for (const theme of ['dark', 'light'] as const) {
    test(`${theme} explore with a result`, async ({ page }) => {
      await page.addInitScript((t) => {
        localStorage.setItem('pulsus-dash.theme', t);
      }, theme);
      await exploreResult(page);
      expect(await seriousViolations(page)).toEqual([]);
    });
  }

  test('dark, completion popup open', async ({ page }) => {
    await exploreResult(page);
    await page.getByRole('textbox', { name: 'PromQL query' }).click();
    await page.keyboard.press('End');
    await page.keyboard.press('Control+Space');
    await page.locator('.cm-tooltip-autocomplete').waitFor();
    expect(await seriousViolations(page)).toEqual([]);
  });

  test('dark, metric picker open', async ({ page }) => {
    await exploreResult(page);
    await page.getByRole('combobox', { name: 'Metric' }).focus();
    await page.getByRole('listbox').waitFor();
    expect(await seriousViolations(page)).toEqual([]);
  });

  test('explore targets are at least 24 × 24 px', async ({ page }) => {
    await exploreResult(page);
    expect(await smallTargets(page)).toEqual([]);
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
