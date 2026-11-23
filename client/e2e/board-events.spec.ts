/**
 * Event markers on board time panels against the http-mode BFF, Postgres and the PulsusDB fake
 * (plan #64 Part C §5, E10–E12): annotations posted through the API show as lines with labels on a
 * line panel and none on a stat tile; a window change and Refresh now update them; the first
 * marker is reached by keyboard and shows its tooltip. The window is the one the `gauge-range`
 * transcript's samples are on (Part B E8).
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { deleteAnnotation, createAnnotation, deleteAnnotations } from './annotationApi.ts';
import { HTTP_BFF, NEEDS_BFF, PREVIEW } from './bff.ts';
import { createBoard, deleteBoard, type PanelInput } from './boardApi.ts';

const FROM = '2026-01-01T00:00:00.000Z';
const TO = '2026-01-01T01:00:00.000Z';
const FROM_MS = Date.parse(FROM);
const MIN = 60_000;
const GAUGE = 'node_memory_free_bytes';

const boardUrl = (uid: string, to = TO, from = FROM): string =>
  `/t/demo/board/${uid}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&refresh=off`;

const panel = (page: Page, title: string): Locator =>
  page
    .locator('[data-panel]')
    .filter({ has: page.getByRole('heading', { level: 3, name: title, exact: true }) });

const PANELS: PanelInput[] = [
  { id: 'p-1', title: 'Memory', text: GAUGE, grid: [0, 0, 8, 10], vis: { kind: 'line' } },
  { id: 'p-2', title: 'Free', text: GAUGE, grid: [8, 0, 4, 6], vis: { kind: 'stat' } },
];

const LABELS = [
  'Deploy · v2.31 · 00:15:00',
  'Config change · flags · 00:30:00',
  'Note · m · 00:45:00',
];

test.describe('e2e:board-event-markers (fake)', () => {
  test.skip(PREVIEW, NEEDS_BFF);
  test.use({ baseURL: HTTP_BFF, viewport: { width: 1440, height: 900 } });
  // The annotations are the organisation's: the three tests share them, one at a time.
  test.describe.configure({ mode: 'serial' });

  let uid: string | null = null;
  let ids: string[] = [];
  test.beforeEach(async ({ request }, info) => {
    uid = await createBoard(request, `E10 ${info.project.name} ${crypto.randomUUID()}`, PANELS);
    ids = [
      await createAnnotation(request, { at: FROM_MS + 15 * MIN, kind: 'deploy', text: 'v2.31' }),
      await createAnnotation(request, { at: FROM_MS + 30 * MIN, kind: 'config', text: 'flags' }),
      await createAnnotation(request, { at: FROM_MS + 45 * MIN, kind: 'annotation', text: 'm' }),
      await createAnnotation(request, { at: FROM_MS - 60 * MIN, kind: 'deploy', text: 'old' }),
    ];
  });
  test.afterEach(async ({ request }) => {
    await deleteAnnotations(request, ids);
    ids = [];
    await deleteBoard(request, uid);
    uid = null;
  });

  test('E10 markers on board time panels', async ({ page }) => {
    if (uid === null) throw new Error('no board');
    await page.goto(boardUrl(uid));
    const memory = panel(page, 'Memory');
    await expect(memory.locator('[data-frame-ready="true"]')).toHaveCount(1);
    const hits = memory.locator('[data-event-hit]');
    await expect(hits).toHaveCount(3);
    expect(await hits.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))).toEqual(
      LABELS,
    );
    await expect(memory.locator('[data-event-hit][aria-label*="old"]')).toHaveCount(0);
    const xs = await hits.evaluateAll((els) =>
      els.map((e) => Number(e.getAttribute('data-event-x'))),
    );
    const [x1, x2, x3] = xs as [number, number, number];
    expect(Math.abs(x2 - x1 - (x3 - x2))).toBeLessThanOrEqual(1);
    const free = panel(page, 'Free');
    await expect(free.locator('[data-frame-ready="true"]')).toHaveCount(1);
    await expect(free.locator('[data-event-hit]')).toHaveCount(0);
    await expect(memory.locator('[data-chart-frame] canvas[role="img"]')).toHaveAttribute(
      'aria-label',
      /Events in view: 3\.$/,
    );
  });

  test('E11 window and refresh update markers', async ({ page, request }) => {
    if (uid === null) throw new Error('no board');
    // The fake answers the gauge with fixed samples at 00:00, 00:30 and 01:00, so the panel draws
    // only in a window that holds them: this one starts 90 min earlier and takes in 'old' (23:00).
    await page.goto(boardUrl(uid, TO, '2025-12-31T22:30:00.000Z'));
    const memory = panel(page, 'Memory');
    await expect(memory.locator('[data-frame-ready="true"]')).toHaveCount(1);
    const hits = memory.locator('[data-event-hit]');
    await expect(hits).toHaveCount(4);
    await expect(hits.first()).toHaveAttribute('aria-label', 'Deploy · old · 23:00:00');
    const old = ids[3];
    if (old === undefined) throw new Error('no annotation');
    await deleteAnnotation(request, old);
    await page.getByRole('button', { name: 'Refresh now' }).click();
    await expect(hits).toHaveCount(3);
    expect(await hits.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))).toEqual(
      LABELS,
    );
  });

  test('E12 markers by keyboard', async ({ page }) => {
    if (uid === null) throw new Error('no board');
    await page.goto(boardUrl(uid));
    const memory = panel(page, 'Memory');
    await expect(memory.locator('[data-event-hit]')).toHaveCount(3);
    const first = memory.locator('[data-event-hit]').first();
    await memory.getByRole('button', { name: 'Panel menu: Memory' }).focus();
    for (let i = 0; i < 20; i++) {
      if (await first.evaluate((el) => el === document.activeElement)) break;
      await page.keyboard.press('Tab');
    }
    await expect(first).toBeFocused();
    await expect(page.getByRole('tooltip')).toHaveText(/^Deploy · v2\.31 · /);
  });
});
