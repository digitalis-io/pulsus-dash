import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { t } from '../src/i18n/t.ts';
import { LEVEL_NAME } from '../src/logs/levels.ts';
import { createAnnotation, deleteAnnotations } from './annotationApi.ts';
import { HTTP_BFF, NEEDS_BFF, PREVIEW } from './bff.ts';
import { createBoard, deleteBoard } from './boardApi.ts';
import {
  ALL_PAGES,
  EXPLORE_RESULT,
  LOGS_RESULT,
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
 * with the panel editor's Title, in its field-errors state too, and the filter dialog's Label as
 * well); Chromium and WebKit run every rule in these states.
 */
const ENGINE_SKIPS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  firefox: {
    'b-1 edit with sections': ['label'],
    'b-1 add filter with error': ['label'],
    'b-1 edit, editor field errors': ['label'],
    // The same crash with the panel editor's PromQL editor loaded (plan #64).
    'b-1 edit, PromQL editor': ['label'],
    'b-1 edit, metric picker open': ['label'],
    'b-1 edit, partial data popover': ['label'],
    // The same crash with the panel editor's threshold rows (#64 Part B).
    'b-1 edit, thresholds': ['label'],
  },
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

// A board with event markers (plan #64 Part C): the stub has no annotations, so the http-mode BFF.
// Annotations are the organisation's: these sit at 01:30, after every window other specs open on the
// same database (`board-events.spec.ts`, `board-thresholds.spec.ts` end at 01:00).
test.describe('e2e:a11y-rooms axe, board with markers', () => {
  test.skip(PREVIEW, NEEDS_BFF);
  test.use({ baseURL: HTTP_BFF });
  for (const theme of ['dark', 'light'] as const) {
    test(`${theme} board with markers`, async ({ page, request }, info) => {
      const from = Date.parse('2026-01-01T00:00:00.000Z');
      const uid = await createBoard(request, `A11y ${info.project.name} ${crypto.randomUUID()}`, [
        {
          id: 'p-1',
          title: 'Memory',
          text: 'node_memory_free_bytes',
          grid: [0, 0, 8, 10],
          vis: { kind: 'line' },
        },
      ]);
      const ids = [
        await createAnnotation(request, { at: from + 90 * 60_000, kind: 'deploy', text: 'v2.31' }),
        await createAnnotation(request, {
          at: from + 90 * 60_000 + 1_000,
          kind: 'flag',
          text: 'checkout',
        }),
      ];
      try {
        await page.addInitScript((t) => {
          localStorage.setItem('pulsus-dash.theme', t);
        }, theme);
        await page.goto(
          `/t/demo/board/${uid}?from=2026-01-01T00%3A00%3A00.000Z&to=2026-01-01T02%3A30%3A00.000Z&refresh=off`,
        );
        // At least this test's chip; markers other specs post at the same time may show too.
        await expect(page.locator('[data-event-hit][aria-label*="checkout"]')).toHaveCount(1);
        expect(await seriousViolations(page, 'board with markers')).toEqual([]);
      } finally {
        await deleteAnnotations(request, ids);
        await deleteBoard(request, uid);
      }
    });
  }

  // The http-mode user's initials (`LU`) are evaluated by axe's label-in-name rule; the stub's
  // `AA` is skipped as symbolic text. Each scan is on a fresh page, the menu opened before its scan:
  // Firefox's page crashes on a pointer click after an axe run in the same page.
  const httpShell = async (page: Page): Promise<void> => {
    await page.goto('/t/demo/boards');
    await page.locator('html[data-shell-ready="true"]').waitFor();
  };

  test('http shell, user menu closed', async ({ page }) => {
    await httpShell(page);
    await page.getByRole('button', { name: 'LU, user menu: Local user' }).waitFor();
    expect(await seriousViolations(page)).toEqual([]);
  });

  test('http shell, user menu open', async ({ page }) => {
    await httpShell(page);
    await page.getByRole('button', { name: 'LU, user menu: Local user' }).click();
    await page.getByRole('menu', { name: 'User menu: Local user' }).waitFor();
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
  // On screen: Request rate and Error ratio; Request latency, below the fold, does not query (T07-012).
  await expect(page.locator('[data-chart-frame][data-frame-ready="true"]')).toHaveCount(2);
  await check('b-1 view');

  const editor = page.getByRole('dialog', { name: 'Edit panel' });
  const edit = async (): Promise<void> => {
    await open(page, '/t/demo/board/b-1');
    await page.getByRole('button', { name: 'Edit board' }).click();
    // The Edit chrome on every panel (one grid serves both modes, #111).
    await expect(page.locator('[data-drag-handle]')).toHaveCount(4);
    await page.getByRole('button', { name: 'Panel menu: Request rate' }).click();
    await page.getByRole('menuitem', { name: 'Edit panel' }).click();
    await editor.waitFor();
  };
  await edit();
  await check('b-1 edit, editor open');

  // #64 Part B (B.3 A1): legends, the stat chip, the compact legend's table and the thresholds.
  await open(page, '/t/demo/board/b-1');
  await expect(page.locator('[data-chart-frame][data-frame-ready="true"]')).toHaveCount(2);
  await page.locator('[data-panel-legend]').first().waitFor();
  await page.locator('[data-stat-chip]').first().waitFor();
  await check('b-1 view, legend and stat chip');

  await open(page, '/t/demo/board/b-1');
  await page.getByRole('button', { name: 'Edit board' }).click();
  await expect(page.locator('.react-grid-item')).toHaveCount(4);
  await page.getByRole('button', { name: 'Move or resize: Request rate' }).focus();
  for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowUp');
  const short = page.locator('[data-panel="p-1"]');
  await expect(short).toHaveAttribute('data-grid', /,4$/);
  await short.locator('[data-panel-legend="compact"]').waitFor();
  await short.getByRole('button', { name: 'Legend table' }).click();
  await page.getByRole('dialog', { name: /^Legend\. / }).waitFor();
  await check('b-1 edit, compact legend table');

  await edit();
  await expect(editor.getByRole('textbox', { name: 'Value' })).toHaveCount(2);
  await check('b-1 edit, thresholds');

  // Plan #64 A.3: the PromQL editor and the metric picker in the dialog.
  await edit();
  await editor.getByRole('textbox', { name: 'Query' }).waitFor();
  await check('b-1 edit, PromQL editor');

  await edit();
  await editor.getByRole('combobox', { name: 'Metric' }).focus();
  await page.getByRole('listbox').waitFor();
  await check('b-1 edit, metric picker open');

  // A panel with partial data: its badge's popover.
  await open(page, '/t/demo/board/b-1');
  await page.getByRole('button', { name: 'Edit board' }).click();
  await expect(page.locator('[data-drag-handle]')).toHaveCount(4);
  await page.getByRole('button', { name: 'Add panel', exact: true }).click();
  await editor.getByRole('textbox', { name: 'Query' }).click();
  await page.keyboard.insertText('topk(1000, up)');
  await page.keyboard.press('Shift+Enter');
  await editor.getByRole('button', { name: 'Done' }).click();
  await expect(editor).toBeHidden();
  await page.getByRole('button', { name: 'Partial data: Untitled panel' }).click();
  await page.getByRole('status', { name: 'Query notices' }).waitFor();
  await check('b-1 edit, partial data popover');

  // A panel whose query failed: the error view.
  await page.addInitScript(() => {
    if (sessionStorage.getItem('a11y-failQuery') === null) {
      sessionStorage.setItem('a11y-failQuery', '1');
      localStorage.setItem('pulsus-dash.stub.failQuery', '1');
    }
  });
  await open(page, '/t/demo/board/b-1');
  await page.getByText('Something went wrong').first().waitFor();
  await check('b-1 view, panel error');

  await edit();
  await editor.getByRole('button', { name: /Visualisation$/ }).click();
  await page.getByRole('listbox').waitFor();
  await check('b-1 edit, select open');

  // #90: field errors from a save, shown under the dialog's fields.
  await edit();
  await editor.getByRole('textbox', { name: 'Title' }).fill('x'.repeat(201));
  await page.keyboard.press('ControlOrMeta+S');
  await editor.getByText('Use at most 200 characters').waitFor();
  await check('b-1 edit, editor field errors');

  await edit();
  await page.keyboard.press('Escape');
  await expect(editor).toBeHidden();
  await page.getByRole('button', { name: 'Add panel', exact: true }).click();
  await editor.waitFor();
  await page.keyboard.press('Escape');
  await expect(editor).toBeHidden();
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
  await expect(page.locator('[data-drag-handle]')).toHaveCount(4);
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

  await valueAxisPinned(page);
  await check('b-1 view, value axis pinned');
}

/** b-1 in View mode with `Request rate`'s value axis pinned by `Shift`+wheel (#93). */
async function valueAxisPinned(page: Page): Promise<void> {
  await open(page, '/t/demo/board/b-1');
  // On screen: Request rate and Error ratio; Request latency, below the fold, does not query (T07-012).
  await expect(page.locator('[data-chart-frame][data-frame-ready="true"]')).toHaveCount(2);
  const f = page.locator('[data-chart-frame]', {
    has: page.getByRole('slider', { name: 'Crosshair: Request rate', exact: true }),
  });
  await expect(f).toHaveAttribute('data-plot', /,/);
  const [x = 0, y = 0, w = 0, h = 0] = ((await f.getAttribute('data-plot')) ?? '')
    .split(',')
    .map(Number);
  const box = await f.boundingBox();
  if (box === null) throw new Error('Request rate has no box');
  await page.mouse.move(box.x + x + w / 2, box.y + y + h / 2);
  await page.keyboard.down('Shift');
  await page.mouse.wheel(0, -200);
  await page.keyboard.up('Shift');
  await page.getByRole('button', { name: 'Reset Y axis: Request rate' }).waitFor();
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
    await expect.poll(() => page.locator('[inert]').count()).toBeGreaterThanOrEqual(1);
    expect(await seriousViolations(page)).toEqual([]);
  });

  test('explore targets are at least 24 × 24 px', async ({ page }) => {
    await exploreResult(page);
    expect(await smallTargets(page)).toEqual([]);
  });
});

/** Explore › Logs with the stub's 30 entries (plan #66 Part C §5.3). */
async function logsResult(page: Page): Promise<void> {
  await open(page, LOGS_RESULT);
  await expect(page.getByRole('list', { name: 'Log lines' }).locator('[data-log-row]')).toHaveCount(
    30,
  );
}

test.describe('e2e:a11y-rooms logs', () => {
  for (const theme of ['dark', 'light'] as const) {
    test(`${theme} explore logs with a result`, async ({ page }) => {
      await page.addInitScript((t) => {
        localStorage.setItem('pulsus-dash.theme', t);
      }, theme);
      await logsResult(page);
      expect(await seriousViolations(page)).toEqual([]);
    });
  }

  test('dark, logs completion popup open', async ({ page }) => {
    await logsResult(page);
    await page.getByRole('textbox', { name: 'LogQL query' }).click();
    // Inside the selector, after `{`: the label names.
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Control+Space');
    await page.locator('.cm-tooltip-autocomplete').waitFor();
    expect(await seriousViolations(page)).toEqual([]);
  });

  test('logs targets are at least 24 × 24 px', async ({ page }) => {
    await logsResult(page);
    expect(await smallTargets(page)).toEqual([]);
  });

  test('the first log line is announced with its level; the glyph is hidden', async ({ page }) => {
    await logsResult(page);
    const first = page.getByRole('list', { name: 'Log lines' }).locator('[data-log-row]').first();
    const names = Object.values(LEVEL_NAME).map((id) => t(id));
    const spoken = await first.evaluate((el) => {
      const parts: string[] = [];
      const walk = (n: Node): void => {
        if (n instanceof Element && n.getAttribute('aria-hidden') === 'true') return;
        if (n.nodeType === Node.TEXT_NODE) parts.push(n.textContent ?? '');
        for (const c of n.childNodes) walk(c);
      };
      walk(el);
      return parts.join('');
    });
    expect(
      names.some((n) => spoken.startsWith(n)),
      spoken,
    ).toBe(true);
    await expect(first.locator('[data-log-glyph]')).toHaveAttribute('aria-hidden', 'true');
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
    await valueAxisPinned(page);
    expect(await smallTargets(page), 'b-1 view, value axis pinned').toEqual([]);
  });
});

test.describe('e2e:a11y-rooms gallery', () => {
  test('gallery canvases expose their summary', async ({ page }) => {
    await open(page, GALLERY_URL);
    await galleryReady(page);
    await expect(page.locator('canvas[role="img"]')).toHaveCount(11);
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
