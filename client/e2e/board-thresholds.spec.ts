/**
 * Board legends, thresholds and stat tiles against the PulsusDB fake through the http-mode BFF
 * (plan #64 Part B Appendix B.3, E7–E9): the legend table with its threshold states, isolation, the
 * compact legend of a 4-row panel by keyboard, Legend Hidden and a threshold edit through save and
 * reload, an unparsable value that blocks the save, and the stat tile's chip, threshold text and
 * sparkline. The window is the one the `gauge-range` transcript's samples are on.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { HTTP_BFF, NEEDS_BFF, PREVIEW } from './bff.ts';
import { BOARDS_API, createBoard, deleteBoard, type PanelInput } from './boardApi.ts';

const FROM = '2026-01-01T00:00:00.000Z';
const TO = '2026-01-01T01:00:00.000Z';
const GAUGE = 'node_memory_free_bytes';

const boardUrl = (uid: string): string =>
  `/t/demo/board/${uid}?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}&refresh=off`;

const panel = (page: Page, title: string): Locator =>
  page
    .locator('[data-panel]')
    .filter({ has: page.getByRole('heading', { level: 3, name: title, exact: true }) });

const LINE_VIS = {
  kind: 'line',
  thresholds: {
    direction: 'above',
    steps: [
      { value: 1.5e9, state: 'watch', label: '' },
      { value: 2.5e9, state: 'degraded', label: 'High' },
    ],
  },
};

const E7_PANELS: PanelInput[] = [
  { id: 'p-1', title: 'Memory', text: GAUGE, grid: [0, 0, 8, 10], vis: LINE_VIS },
  { id: 'p-2', title: 'Short', text: GAUGE, grid: [8, 0, 4, 4], vis: LINE_VIS },
];

/** B.4 matrix L: per row a, b, c, the `data-state` of Mean, Max and Last ('' = none). */
const MATRIX = [
  ['watch', 'degraded', ''],
  ['watch', 'watch', 'watch'],
  ['', '', ''],
];

async function states(table: Locator): Promise<string[][]> {
  return table.locator('tbody tr').evaluateAll((rows) =>
    rows.map((r) =>
      // After the Select toggle (T25-016) and the series name.
      [...r.querySelectorAll('td')].slice(2).map((c) => c.getAttribute('data-state') ?? ''),
    ),
  );
}

async function headers(table: Locator): Promise<string[]> {
  return (await table.locator('thead th').allTextContents()).map((s) => s.trim());
}

/** The panel's chart summary label (the canvas's accessible name). */
const chartLabel = (p: Locator): Locator => p.locator('[data-chart-frame] canvas[role="img"]');

/**
 * Ink in the sparkline band of the panel's visible canvas: pixels whose largest RGB channel
 * difference from the pixel at (2, 2) is over 48, over CSS x ∈ [12, w − 12], y ∈ [h − 40, h − 8].
 */
async function sparkInk(page: Page, title: string): Promise<number> {
  const canvas = panel(page, title).locator('[data-chart-frame] canvas').first();
  return canvas.evaluate((c: HTMLCanvasElement) => {
    const ctx = c.getContext('2d');
    if (ctx === null) return -1;
    const dpr = c.width / c.clientWidth;
    const w = c.clientWidth;
    const h = c.clientHeight;
    const bg = ctx.getImageData(2 * dpr, 2 * dpr, 1, 1).data;
    const x0 = Math.round(12 * dpr);
    const y0 = Math.round((h - 40) * dpr);
    const bw = Math.round((w - 24) * dpr);
    const bh = Math.round(32 * dpr);
    if (bw <= 0 || bh <= 0) return 0;
    const d = ctx.getImageData(x0, y0, bw, bh).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const diff = Math.max(
        Math.abs((d[i] ?? 0) - (bg[0] ?? 0)),
        Math.abs((d[i + 1] ?? 0) - (bg[1] ?? 0)),
        Math.abs((d[i + 2] ?? 0) - (bg[2] ?? 0)),
      );
      if (diff > 48) n += 1;
    }
    return n;
  });
}

test.describe('e2e:board-thresholds (fake)', () => {
  test.skip(PREVIEW, NEEDS_BFF);
  test.use({ baseURL: HTTP_BFF, viewport: { width: 1440, height: 900 } });

  let uid: string | null = null;
  test.afterEach(async ({ request }) => {
    await deleteBoard(request, uid);
    uid = null;
  });

  test('e2e:board-thresholds-legend', async ({ page, request }, info) => {
    test.setTimeout(120_000);
    uid = await createBoard(request, `E7 ${info.project.name} ${crypto.randomUUID()}`, E7_PANELS);
    await page.goto(boardUrl(uid));
    const memory = panel(page, 'Memory');
    const short = panel(page, 'Short');
    await expect(memory.locator('[data-frame-ready="true"]')).toHaveCount(1);
    await expect(short.locator('[data-frame-ready="true"]')).toHaveCount(1);

    // The table legend of the tall panel: mean, max and last with the threshold states.
    const legend = memory.locator('[data-panel-legend="table"]');
    const table = legend.getByRole('table');
    await expect(table.locator('tbody tr')).toHaveCount(3);
    expect(await headers(table)).toEqual(['Select', 'Series', 'Mean', 'Max', 'Last']);
    expect(await states(table)).toEqual(MATRIX);
    await expect(table.locator('td[data-state="degraded"]').first()).toHaveText(/^◉/);

    // The 4-row panel: a compact legend, reached by keyboard from its header.
    const compact = short.locator('[data-panel-legend="compact"]');
    await expect(compact.locator('[data-legend-item]')).toHaveCount(3);
    await short.getByRole('button', { name: 'Panel menu: Short' }).focus();
    // Until focus is on a legend item: Firefox also stops on the scrolling list itself.
    for (let i = 0; i < 60; i++) {
      const onItem = await compact.evaluate(
        (el) =>
          el.contains(document.activeElement) &&
          document.activeElement?.matches('[data-legend-item]') === true,
      );
      if (onItem) break;
      await page.keyboard.press('Tab');
    }
    const first = compact.locator('[data-legend-item]').first();
    await expect(first).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(first).toHaveAttribute('aria-pressed', 'true');
    await expect(chartLabel(short)).toHaveAttribute('aria-label', /, 1 series,/);
    const button = compact.getByRole('button', { name: 'Legend table' });
    for (let i = 0; i < 10; i++) {
      if (await button.evaluate((el) => el === document.activeElement)) break;
      await page.keyboard.press('Tab');
    }
    await expect(button).toBeFocused();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: /^Legend\. / });
    const popoverTable = dialog.getByRole('table');
    expect(await headers(popoverTable)).toEqual(['Select', 'Series', 'Mean', 'Max', 'Last']);
    expect(await states(popoverTable)).toEqual(MATRIX);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(button).toBeFocused();

    // A row isolates its series locally; a second choice shows all again.
    // Exact: the row's Select toggle (T25-016) is named "Select <series>".
    const row = legend.getByRole('button', { name: `${GAUGE}{instance="a:9100"}`, exact: true });
    await row.click();
    await expect(row).toHaveAttribute('aria-pressed', 'true');
    await expect(chartLabel(memory)).toHaveAttribute('aria-label', /, 1 series,/);
    await row.click();
    await expect(chartLabel(memory)).toHaveAttribute('aria-label', /, 3 series,/);

    // Legend Hidden and a threshold edit survive save and reload.
    await page.getByRole('button', { name: 'Edit board' }).click();
    // The Edit grid is a lazy chunk; its panels replace the View grid's once it has loaded.
    await expect(page.locator('.react-grid-item')).toHaveCount(2);
    await page.getByRole('button', { name: 'Panel menu: Memory' }).click();
    await page.getByRole('menuitem', { name: 'Edit panel' }).click();
    const editor = page.getByRole('dialog', { name: 'Edit panel' });
    await editor.getByRole('button', { name: /Legend$/ }).click();
    await page.getByRole('option', { name: 'Hidden', exact: true }).click();
    await editor.getByRole('textbox', { name: 'Value' }).nth(1).fill('3e9');
    await editor.getByRole('button', { name: 'Done' }).click();
    await expect(editor).toBeHidden();
    await page.keyboard.press('ControlOrMeta+S');
    await expect(page.getByRole('status', { name: 'Save status' })).toHaveText('Saved');
    await page.reload();
    await expect(memory.locator('[data-frame-ready="true"]')).toHaveCount(1);
    await expect(memory.locator('[data-panel-legend]')).toHaveCount(0);
    const got = await request.get(`${BOARDS_API}/${uid}`);
    const body = (await got.json()) as {
      schema_version: number;
      spec: { panels: { vis: unknown }[] };
    };
    expect(body.schema_version).toBe(4);
    expect(body.spec.panels[0]?.vis).toEqual({
      kind: 'line',
      thresholds: {
        direction: 'above',
        steps: [
          { value: 1500000000, state: 'watch', label: '' },
          { value: 3000000000, state: 'degraded', label: 'High' },
        ],
      },
      legend: { mode: 'hidden' },
    });
  });

  test('e2e:board-thresholds-legend validation', async ({ page, request }, info) => {
    test.setTimeout(120_000);
    uid = await createBoard(request, `E9 ${info.project.name} ${crypto.randomUUID()}`, E7_PANELS);
    const puts: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'PUT' && new URL(r.url()).pathname.startsWith(`${BOARDS_API}/`)) {
        puts.push(r.url());
      }
    });
    await page.goto(boardUrl(uid));
    await expect(panel(page, 'Memory').locator('[data-frame-ready="true"]')).toHaveCount(1);
    await page.getByRole('button', { name: 'Edit board' }).click();
    // The Edit grid is a lazy chunk; its panels replace the View grid's once it has loaded.
    await expect(page.locator('.react-grid-item')).toHaveCount(2);
    await page.getByRole('button', { name: 'Panel menu: Memory' }).click();
    await page.getByRole('menuitem', { name: 'Edit panel' }).click();
    const editor = page.getByRole('dialog', { name: 'Edit panel' });
    await editor.getByRole('textbox', { name: 'Value' }).first().fill('abc');
    await page.keyboard.press('ControlOrMeta+S');
    await expect(editor.getByText('Enter a number')).toBeVisible();
    await expect(editor.getByRole('status', { name: 'Save status' })).toHaveText(
      'Problems to fix before saving: 1',
    );
    expect(puts).toEqual([]);
  });

  test('e2e:board-stat-tile', async ({ page, request }, info) => {
    test.setTimeout(120_000);
    uid = await createBoard(request, `E8 ${info.project.name} ${crypto.randomUUID()}`, [
      {
        id: 'p-1',
        title: 'Free',
        text: GAUGE,
        grid: [0, 0, 4, 5],
        vis: {
          kind: 'stat',
          thresholds: {
            direction: 'below',
            steps: [{ value: 1.5e9, state: 'degraded', label: 'Low' }],
          },
        },
      },
      {
        id: 'p-2',
        title: 'Plain',
        text: 'scalar(vector(1)) / 0',
        grid: [4, 0, 4, 5],
        vis: { kind: 'stat' },
      },
    ]);
    await page.goto(boardUrl(uid));
    const free = panel(page, 'Free');
    const plain = panel(page, 'Plain');
    await expect(free.locator('[data-frame-ready="true"]')).toHaveCount(1);
    await expect(plain.locator('[data-frame-ready="true"]')).toHaveCount(1);
    const chip = free.locator('[data-stat-chip]');
    await expect(chip).toHaveAttribute('data-state', 'degraded');
    await expect(chip).toContainText('Degraded');
    const text = free.locator('[data-stat-threshold]');
    await expect(text).toHaveText('◉ Low');
    await expect(text).toHaveAttribute('data-crossed', '');
    await expect(plain.locator('[data-stat-chip]')).toHaveCount(0);
    await expect(plain.locator('[data-stat-threshold]')).toHaveCount(0);
    // A range series draws a sparkline in its band; a scalar draws none.
    await expect.poll(() => sparkInk(page, 'Free')).toBeGreaterThan(40);
    expect(await sparkInk(page, 'Plain')).toBe(0);
  });
});
