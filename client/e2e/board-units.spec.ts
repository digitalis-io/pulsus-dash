/**
 * `e2e:board-units` (#290 §5 E1–E3; VL-012, T22-015): panel units against the PulsusDB fake through
 * the http-mode BFF. A stat in seconds reads 7.77 d on its frame and in the Inspector; a line in
 * bytes per second has its legend and tooltip in MiB/s; the editor's Unit field picks Seconds,
 * which survives save and reload at the units version. The window is the one of the `units-*`
 * transcripts (as `gauge-range`).
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { HTTP_BFF, NEEDS_BFF, PREVIEW } from './bff.ts';
import { BOARDS_API, createBoard, deleteBoard } from './boardApi.ts';

const FROM = '2026-01-01T00:00:00.000Z';
const TO = '2026-01-01T01:00:00.000Z';
/** The board spec version that adds `vis.unit` (BoardSchemaVersion). */
const UNITS_VERSION = 8;

const boardUrl = (uid: string): string =>
  `/t/demo/board/${uid}?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}&refresh=off`;

const panel = (page: Page, title: string): Locator =>
  page
    .locator('[data-panel]')
    .filter({ has: page.getByRole('heading', { level: 3, name: title, exact: true }) });

const chartLabel = (p: Locator): Locator => p.locator('[data-chart-frame] canvas[role="img"]');

async function headers(table: Locator): Promise<string[]> {
  return (await table.locator('thead th').allTextContents()).map((s) => s.trim());
}

test.describe('e2e:board-units (fake)', () => {
  test.skip(PREVIEW, NEEDS_BFF);
  test.use({ baseURL: HTTP_BFF, viewport: { width: 1440, height: 900 } });

  let uid: string | null = null;
  test.afterEach(async ({ request }) => {
    await deleteBoard(request, uid);
    uid = null;
  });

  test('e2e:board-units stat in seconds', async ({ page, request }, info) => {
    test.setTimeout(120_000);
    uid = await createBoard(request, `U1 ${info.project.name} ${crypto.randomUUID()}`, [
      {
        id: 'p-1',
        title: 'Uptime',
        text: 'uptime_seconds',
        grid: [0, 0, 4, 5],
        vis: { kind: 'stat', unit: { id: 'seconds' } },
      },
    ]);
    await page.goto(boardUrl(uid));
    const uptime = panel(page, 'Uptime');
    await expect(uptime.locator('[data-frame-ready="true"]')).toHaveCount(1);
    await expect(chartLabel(uptime)).toHaveAttribute('aria-label', /7\.77 d/);
    await page
      .getByRole('button', { name: 'Inspect Uptime' })
      .click({ position: { x: 24, y: 24 } });
    const value = page.locator('[data-inspector]:not([data-closing]) [data-inspector-value]');
    await expect(value).toContainText('7.77');
    await expect(value.locator('span').last()).toHaveText(/^\s*d$/);
  });

  test('e2e:board-units line in bytes per second', async ({ page, request }, info) => {
    test.setTimeout(120_000);
    uid = await createBoard(request, `U2 ${info.project.name} ${crypto.randomUUID()}`, [
      {
        id: 'p-1',
        title: 'Received',
        text: 'rx_bytes_rate',
        grid: [0, 0, 8, 10],
        vis: { kind: 'line', unit: { id: 'bytesPerSecond' } },
      },
    ]);
    await page.goto(boardUrl(uid));
    const rx = panel(page, 'Received');
    await expect(rx.locator('[data-frame-ready="true"]')).toHaveCount(1);
    const table = rx.locator('[data-panel-legend="table"]').getByRole('table');
    await expect(table.locator('tbody tr')).toHaveCount(1);
    expect(await headers(table)).toEqual(['Select', 'Series', 'Mean', 'Max', 'Last']);
    const cells = (await table.locator('tbody tr td').allTextContents())
      .slice(2)
      .map((s) => s.trim());
    expect(cells).toEqual(['1.5 MiB/s', '3 MiB/s', '3 MiB/s']);
    const frame = rx.locator('[data-chart-frame]');
    const box = await frame.boundingBox();
    if (box === null) throw new Error('no box');
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5);
    const tip = frame.locator('[data-chart-tooltip]');
    await expect(tip).toBeVisible();
    await expect(tip.locator('[data-value]').first()).toHaveText(/(B|KiB|MiB)\/s$/);
  });

  test('e2e:board-units editor round trip', async ({ page, request }, info) => {
    test.setTimeout(120_000);
    uid = await createBoard(request, `U3 ${info.project.name} ${crypto.randomUUID()}`, [
      {
        id: 'p-1',
        title: 'Uptime',
        text: 'uptime_seconds',
        grid: [0, 0, 6, 8],
        vis: { kind: 'line' },
      },
    ]);
    await page.goto(boardUrl(uid));
    const uptime = panel(page, 'Uptime');
    await expect(uptime.locator('[data-frame-ready="true"]')).toHaveCount(1);
    await page.getByRole('button', { name: 'Edit board' }).click();
    await expect(page.locator('.react-grid-item')).toHaveCount(1);
    await page.getByRole('button', { name: 'Panel menu: Uptime' }).click();
    await page.getByRole('menuitem', { name: 'Edit panel' }).click();
    const editor = page.getByRole('dialog', { name: 'Edit panel' });
    const unit = editor.getByRole('button', { name: /Unit$/ });
    await expect(unit).toHaveText(/Auto/);
    await unit.click();
    await page.getByRole('option', { name: /^Seconds · / }).click();
    await expect(unit).toHaveText(/Seconds/);
    await editor.getByRole('button', { name: 'Done' }).click();
    await expect(editor).toBeHidden();
    await page.keyboard.press('ControlOrMeta+S');
    await expect(page.getByRole('status', { name: 'Save status' })).toHaveText('Saved');
    await page.reload();
    await expect(uptime.locator('[data-frame-ready="true"]')).toHaveCount(1);
    const got = await request.get(`${BOARDS_API}/${uid}`);
    const body = (await got.json()) as {
      schema_version: number;
      spec: { panels: { vis: { unit?: { id: string } } }[] };
    };
    expect(body.schema_version).toBe(UNITS_VERSION);
    expect(body.spec.panels[0]?.vis.unit).toEqual({ id: 'seconds' });
    await page.getByRole('button', { name: 'Edit board' }).click();
    await expect(page.locator('.react-grid-item')).toHaveCount(1);
    await page.getByRole('button', { name: 'Panel menu: Uptime' }).click();
    await page.getByRole('menuitem', { name: 'Edit panel' }).click();
    await expect(
      page.getByRole('dialog', { name: 'Edit panel' }).getByRole('button', { name: /Unit$/ }),
    ).toHaveText(/Seconds/);
  });
});
