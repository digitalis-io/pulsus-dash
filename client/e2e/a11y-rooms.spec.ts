import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { HTTP_BFF, PREVIEW } from './bff.ts';
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

/**
 * The board states of plan #61 Part B §5.3; `check` runs in each. Each state is entered afresh:
 * Firefox's page crashes on a pointer click after an axe run in the same page.
 */
async function boardStates(
  page: Page,
  request: APIRequestContext,
  check: (state: string) => Promise<void>,
): Promise<void> {
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

  // A failed star needs the BFF (the stub makes no request to fail): a board of its own there.
  if (!PREVIEW) {
    const created = await request.post(`${HTTP_BFF}/api/dash/v1/boards`, {
      data: { spec: { title: `A11y star ${crypto.randomUUID()}`, panels: [], sections: [] } },
    });
    expect(created.status()).toBe(201);
    const { uid, etag } = (await created.json()) as { uid: string; etag: string };
    try {
      await page.route('**/api/dash/v1/me/starred-boards/*', (r) => r.fulfill({ status: 503 }));
      await open(page, `${HTTP_BFF}/t/demo/board/${uid}`);
      await page.getByRole('button', { name: 'Star board' }).click();
      await page.getByText('Could not update Starred. Try again.').waitFor();
      await check('b-1 star failed');
    } finally {
      await page.unroute('**/api/dash/v1/me/starred-boards/*');
      await request.delete(`${HTTP_BFF}/api/dash/v1/boards/${uid}`, {
        headers: { 'If-Match': `"${etag}"` },
      });
    }
  }
}

test.describe('e2e:a11y-rooms boards', () => {
  for (const theme of ['dark', 'light'] as const) {
    test(`${theme} board list and board states`, async ({ page, request }) => {
      test.setTimeout(120_000);
      await page.addInitScript((t) => {
        localStorage.setItem('pulsus-dash.theme', t);
      }, theme);
      await boardStates(page, request, async (state) => {
        expect(await seriousViolations(page), state).toEqual([]);
      });
    });
  }

  test('board targets are at least 24 × 24 px', async ({ page, request }) => {
    test.setTimeout(120_000);
    await boardStates(page, request, async (state) => {
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
