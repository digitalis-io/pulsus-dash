/**
 * The Inspector, the shared selection, the Esc ladder and pivots (T25 §10, plan #192 §5) against the
 * PulsusDB fake through the http-mode BFF. The boards are created through the boards API on the
 * windows of the `inspector-*` transcripts (2026-11-19 UTC): "inspector kinds" on 12:44–13:44
 * (fixture P's p99, the bucket heatmap, the checkout log lines), "inspector selection" and
 * "inspector logs" on 12:00–15:00 (two series, two log streams, a heatmap in 30 s columns).
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { HTTP_BFF, NEEDS_BFF, PREVIEW } from './bff.ts';
import { createBoard, deleteBoard, type PanelInput } from './boardApi.ts';
import { fakeRequests } from './fake.ts';

const K_FROM = Date.UTC(2026, 10, 19, 12, 44);
const K_TO = Date.UTC(2026, 10, 19, 13, 44);
const S_FROM = Date.UTC(2026, 10, 19, 12, 0);
/** 3 h: a board panel of ~570 px plans 30 s steps on it, so H's buckets are 30 s. */
const S_TO = Date.UTC(2026, 10, 19, 15, 0);
/** Fixture P's instant: 13:41:20. */
const P_T = Date.UTC(2026, 10, 19, 13, 41, 20);
const P99 = 'histogram_quantile(0.99, x)';
const HIST = 'sum by (le) (rate(inspector_bucket[5m]))';

const iso = (ms: number): string => new Date(ms).toISOString();
const e = encodeURIComponent;

function boardUrl(uid: string, from: number, to: number, extra = ''): string {
  return `/t/demo/board/${uid}?from=${e(iso(from))}&to=${e(iso(to))}&refresh=off${extra}`;
}

const KINDS: PanelInput[] = [
  { id: 'p1', title: 'p99 latency', text: P99, grid: [0, 0, 6, 8], vis: { kind: 'line' } },
  { id: 'p2', title: 'p99 bars', text: P99, grid: [6, 0, 6, 8], vis: { kind: 'bars' } },
  { id: 'p3', title: 'latency buckets', text: HIST, grid: [0, 8, 6, 8], vis: { kind: 'heatmap' } },
  { id: 'p4', title: 'p99 now', text: P99, grid: [6, 8, 6, 8], vis: { kind: 'stat' } },
  {
    id: 'p5',
    title: 'checkout logs',
    text: '{service_name="checkout"}',
    lang: 'logql',
    grid: [0, 16, 12, 8],
    vis: { kind: 'logs' },
  },
];

const SELECTION: PanelInput[] = [
  { id: 'a', title: 'A', text: 'inspector_two', grid: [0, 0, 6, 8], vis: { kind: 'line' } },
  { id: 'b', title: 'B', text: 'inspector_two', grid: [6, 0, 6, 8], vis: { kind: 'line' } },
];

const LOGS_BOARD: PanelInput[] = [
  {
    id: 'l1',
    title: 'L1',
    text: '{app="inspector"}',
    lang: 'logql',
    grid: [0, 0, 6, 8],
    vis: { kind: 'logs' },
  },
  {
    id: 'l2',
    title: 'L2',
    text: '{app="inspector"}',
    lang: 'logql',
    grid: [6, 0, 6, 8],
    vis: { kind: 'logs' },
  },
  { id: 'b', title: 'B', text: 'inspector_two', grid: [0, 8, 6, 8], vis: { kind: 'line' } },
  { id: 'h', title: 'H', text: HIST, grid: [6, 8, 6, 8], vis: { kind: 'heatmap' } },
];

const panel = (page: Page, id: string): Locator => page.locator(`[data-panel-id="${id}"]`);
const aside = (page: Page): Locator => page.locator('[data-inspector]:not([data-closing])');
/** The incoming layer: during a crossfade the outgoing one is still in the DOM for 150 ms. */
const current = (page: Page): Locator =>
  aside(page).locator('[data-inspector-content]:not([data-leaving])');
const heading = (page: Page): Locator => aside(page).getByRole('heading', { level: 2 });

/** The page point of `tMs` at the fraction `fy` of the plot's height, in panel `id`'s chart. */
async function plotPoint(
  page: Page,
  id: string,
  tMs: number,
  fy: number,
  from: number,
  to: number,
): Promise<{ x: number; y: number }> {
  const frame = panel(page, id).locator('[data-chart-frame][data-frame-ready="true"]');
  await frame.scrollIntoViewIfNeeded();
  const box = await frame.boundingBox();
  const plot = (await frame.getAttribute('data-plot'))?.split(',').map(Number) ?? [];
  const [px = 0, py = 0, pw = 0, ph = 0] = plot;
  if (box === null) throw new Error(`no chart box in ${id}`);
  return { x: box.x + px + ((tMs - from) / (to - from)) * pw, y: box.y + py + fy * ph };
}

async function clickAt(page: Page, p: { x: number; y: number }): Promise<void> {
  await page.mouse.click(p.x, p.y);
}

/** Opens fixture P: a click on p1 at 13:41:20 near the top, nearest the checkout series. */
async function inspectP(page: Page): Promise<void> {
  await clickAt(page, await plotPoint(page, 'p1', P_T, 0.12, K_FROM, K_TO));
  await expect(heading(page)).toHaveText('p99 latency');
}

async function withBoard(
  page: Page,
  request: Parameters<typeof createBoard>[0],
  name: string,
  panels: PanelInput[],
  url: (uid: string) => string,
  body: () => Promise<void>,
): Promise<void> {
  const uid = await createBoard(request, `${name} ${crypto.randomUUID()}`, panels);
  try {
    await page.goto(url(uid));
    await page.locator('html[data-shell-ready="true"]').waitFor();
    await body();
  } finally {
    await deleteBoard(request, uid);
  }
}

/** The time from the gesture to the first frame with the sheet in the DOM, in the page. */
async function armOpenTimer(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __inspectMs: number | null };
    w.__inspectMs = null;
    let t0 = 0;
    const start = (): void => {
      t0 = performance.now();
    };
    document.addEventListener('pointerup', start, { capture: true, once: true });
    document.addEventListener('keydown', start, { capture: true, once: true });
    const mo = new MutationObserver(() => {
      if (document.querySelector('[data-inspector]') === null || t0 === 0) return;
      mo.disconnect();
      requestAnimationFrame(() => {
        w.__inspectMs = performance.now() - t0;
      });
    });
    mo.observe(document.body, { childList: true, subtree: true });
  });
}

async function openMs(page: Page): Promise<number> {
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { __inspectMs: number | null }).__inspectMs),
    )
    .not.toBeNull();
  return page.evaluate(() => (window as unknown as { __inspectMs: number }).__inspectMs);
}

test.describe('e2e:inspector (fake)', () => {
  test.skip(PREVIEW, NEEDS_BFF);
  test.use({ baseURL: HTTP_BFF, viewport: { width: 1440, height: 900 } });

  test('e2e:inspector-open', async ({ page, request, browserName }) => {
    test.setTimeout(120_000);
    await withBoard(
      page,
      request,
      'inspector kinds',
      KINDS,
      (u) => boardUrl(u, K_FROM, K_TO),
      async () => {
        // p1 line, by pointer: within 250 ms and a frame; the origin is outlined.
        await armOpenTimer(page);
        await inspectP(page);
        // The budget is measured on Chromium (as the other benches); every engine still opens.
        const ms = await openMs(page);
        if (browserName === 'chromium') expect(ms).toBeLessThan(250 + 50);
        await expect(current(page).locator('[data-inspector-value]')).toContainText('2.84');
        await expect(panel(page, 'p1')).toHaveAttribute('data-inspector-origin', '');
        // p2 bars, p3 heatmap: a click inspects them.
        // The right-hand column, left of the open sheet (it floats over the content).
        await clickAt(page, await plotPoint(page, 'p2', K_FROM + 600_000, 0.97, K_FROM, K_TO));
        await expect(heading(page)).toHaveText('p99 bars');
        await expect(panel(page, 'p2')).toHaveAttribute('data-inspector-origin', '');
        await clickAt(page, await plotPoint(page, 'p3', P_T, 0.5, K_FROM, K_TO));
        await expect(heading(page)).toHaveText('latency buckets');
        await expect(aside(page)).toContainText('Range');
        // p4 stat: its inspect button.
        await page
          .getByRole('button', { name: 'Inspect p99 now' })
          .click({ position: { x: 24, y: 24 } });
        await expect(heading(page)).toHaveText('p99 now');
        // p5 logs: a row click.
        // A panel runs once it is on screen (T07-012).
        await panel(page, 'p5').scrollIntoViewIfNeeded();
        const row = panel(page, 'p5').locator('[data-log-row]').first();
        await row.click();
        await expect(heading(page)).toHaveText('checkout logs');
        await expect(current(page).locator('[data-inspector-value]')).toHaveText(
          'order accepted, items=3',
        );
        // Keyboard: Enter on p1's crosshair inspects and focuses the heading.
        const slider = panel(page, 'p1').getByRole('slider');
        await slider.scrollIntoViewIfNeeded();
        await slider.focus();
        await page.keyboard.press('End');
        // The crosshair is shown (the idle text goes), at the last sample.
        await expect(slider).not.toHaveAttribute(
          'aria-valuetext',
          'Use the arrow keys to read values',
        );
        await expect(slider).toHaveAttribute('aria-valuenow', String(K_TO));
        await page.keyboard.press('Enter');
        await expect(heading(page)).toHaveText('p99 latency');
        await expect(heading(page)).toBeFocused();
      },
    );

    // Explore › Metrics: no Explore chip.
    await page.goto(
      `/t/demo/explore/metrics?from=${e(iso(K_FROM))}&to=${e(iso(K_TO))}&refresh=off&q=${e(P99)}&vis=line`,
    );
    const frame = page.locator('[data-chart-frame][data-frame-ready="true"]');
    await frame.waitFor();
    // The result is drawn: its three series are in the table.
    await expect(page.getByRole('table').getByRole('row')).toHaveCount(4);
    await expect(frame.locator('canvas')).toHaveAttribute('aria-label', /3 series/);
    // Explore's chart plans a 5 s grid on which the 10 s samples leave every other step empty: a
    // click on an empty step selects nothing (T25 §4.2), so the pixels next to 13:41:20 are tried
    // too (an engine may round the pointer to a whole pixel).
    await expect(async () => {
      const box = await frame.boundingBox();
      const [px = 0, py = 0, pw = 0, ph = 0] =
        (await frame.getAttribute('data-plot'))?.split(',').map(Number) ?? [];
      if (box === null) throw new Error('no Explore chart');
      const x = Math.round(box.x + px + ((P_T - K_FROM) / (K_TO - K_FROM)) * pw);
      for (const dx of [0, 1, -1, 2, -2]) {
        await page.mouse.click(x + dx, box.y + py + 0.12 * ph);
        if ((await aside(page).count()) > 0) break;
      }
      await expect(heading(page)).toHaveText('Query result', { timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
    await expect(heading(page)).toHaveText('Query result');
    await expect(current(page).locator('[data-pivot="explore"]')).toHaveCount(0);
    await expect(current(page).locator('[data-pivot="logs"]')).toHaveAttribute(
      'href',
      /explore\/logs/,
    );

    // Explore › Logs: a row click.
    await page.goto(
      `/t/demo/explore/logs?from=${e(iso(K_FROM))}&to=${e(iso(K_TO))}&refresh=off&q=${e('{service_name="checkout"}')}`,
    );
    const first = page.locator('[data-log-row]').first();
    await first.click();
    await expect(heading(page)).toHaveText('Log lines');
    await expect(current(page).locator('[data-pivot="explore"]')).toHaveCount(0);
  });

  test('e2e:inspector-sections, e2e:inspector-pivot-nav', async ({ page, request, context }) => {
    test.setTimeout(120_000);
    await withBoard(
      page,
      request,
      'inspector kinds',
      KINDS,
      (u) => boardUrl(u, K_FROM, K_TO),
      async () => {
        await inspectP(page);
        const sections = await aside(page)
          .locator('[data-inspector-content]:not([data-leaving]) [data-section]')
          .evaluateAll((els) => els.map((el) => el.getAttribute('data-section')));
        expect(sections).toEqual([
          'header',
          'value',
          'details',
          'labels',
          'pivots',
          'query',
          'actions',
        ]);
        await expect(current(page).locator('a[data-pivot]')).toHaveCount(2);
        await expect(current(page).locator('[data-pivot][aria-disabled="true"]')).toHaveCount(4);
        for (const reason of [
          'Traces are not available yet',
          'Profiles are not available yet',
          'The entity catalogue is not available yet',
          'Filtering Explore by a label arrives with label filters',
        ]) {
          await expect(current(page).getByText(reason)).toBeVisible();
        }
        await expect(current(page).locator('[data-action][aria-disabled="true"]')).toHaveCount(3);
        const boardUrlNow = page.url();
        const logs = current(page).locator('a[data-pivot="logs"]');
        const href = (await logs.getAttribute('href')) ?? '';
        const u = new URL(href, 'http://x');
        expect(u.pathname).toMatch(/\/explore\/logs$/);
        expect(u.searchParams.get('from')).toBe('2026-11-19T13:40:20.000Z');
        expect(u.searchParams.get('to')).toBe('2026-11-19T13:42:20.000Z');
        expect(u.searchParams.get('q')).toBe('{service_name="checkout"}');
        // Plain click navigates in place; Back restores the board.
        await logs.click();
        await expect(page).toHaveURL(/\/explore\/logs\?/);
        await page.goBack();
        await expect(page).toHaveURL(boardUrlNow);
        // Shift-click navigates in place too.
        await inspectP(page);
        await current(page)
          .locator('a[data-pivot="logs"]')
          .click({ modifiers: ['Shift'] });
        await expect(page).toHaveURL(/\/explore\/logs\?/);
        await page.goBack();
        // Ctrl-click opens a new page with the same href.
        await inspectP(page);
        const opened = context.waitForEvent('page');
        await current(page)
          .locator('a[data-pivot="logs"]')
          .click({ modifiers: ['ControlOrMeta'] });
        const other = await opened;
        await other.waitForLoadState('domcontentloaded');
        expect(new URL(other.url()).pathname + new URL(other.url()).search).toBe(href);
        await other.close();
        await expect(page).toHaveURL(boardUrlNow);
      },
    );
  });

  test('e2e:inspector-escape', async ({ page, request }) => {
    test.setTimeout(120_000);
    await withBoard(
      page,
      request,
      'inspector kinds',
      KINDS,
      (u) => boardUrl(u, K_FROM, K_TO),
      async () => {
        const slider = panel(page, 'p1').getByRole('slider');
        const frame = panel(page, 'p1').locator('[data-chart-frame]');
        await frame.locator('[data-frame-ready="true"]').or(frame).first().waitFor();
        await slider.focus();
        await page.keyboard.press('End');
        // 10 s samples: 13:44 back to 13:41:20.
        for (let i = 0; i < 16; i++) await page.keyboard.press('ArrowLeft');
        await expect(slider).toHaveAttribute('aria-valuenow', String(P_T));
        await page.keyboard.press('Enter');
        await expect(heading(page)).toBeFocused();
        // Back on the slider with the crosshair shown.
        await slider.focus();
        await page.keyboard.press('ArrowRight');
        await expect(slider).not.toHaveAttribute(
          'aria-valuetext',
          'Use the arrow keys to read values',
        );
        // Esc 1: the crosshair goes; the Inspector stays.
        await page.keyboard.press('Escape');
        await expect(slider).toHaveAttribute('aria-valuetext', 'Use the arrow keys to read values');
        await expect(aside(page)).toBeVisible();
        // Tab from the heading lands on Collapse.
        await heading(page).focus();
        await page.keyboard.press('Tab');
        await expect(aside(page).getByRole('button', { name: 'Collapse Inspector' })).toBeFocused();
        // Esc 2: the selection clears.
        await page.keyboard.press('Escape');
        await expect(frame).toHaveAttribute('data-selection-keys', '');
        await expect(aside(page)).toBeVisible();
        // Esc 3: the Inspector closes; focus returns to the slider.
        await page.keyboard.press('Escape');
        await expect(page.locator('[data-inspector]')).toHaveCount(0);
        await expect(slider).toBeFocused();
        // With the panel editor open, Esc closes only the editor.
        await inspectP(page);
        await panel(page, 'p1').getByRole('button', { name: 'Panel menu: p99 latency' }).click();
        await page.getByRole('menuitem', { name: 'Edit panel' }).click();
        const editor = page.getByRole('dialog', { name: 'Edit panel' });
        await expect(editor).toBeVisible();
        await editor.getByRole('textbox', { name: 'Title' }).focus();
        await page.keyboard.press('Escape');
        await expect(editor).toBeHidden();
        await expect(page.locator('[data-inspector]:not([data-closing])')).toHaveCount(1);
        await expect(frame).not.toHaveAttribute('data-selection-keys', '');
      },
    );
  });

  test('e2e:inspector-keyboard', async ({ page, request }) => {
    test.setTimeout(120_000);
    await withBoard(
      page,
      request,
      'inspector kinds',
      KINDS,
      (u) => boardUrl(u, K_FROM, K_TO),
      async () => {
        // A panel runs once it is on screen (T07-012).
        await panel(page, 'p5').scrollIntoViewIfNeeded();
        const scroller = panel(page, 'p5').locator('[data-log-scroller]');
        await expect(panel(page, 'p5').locator('[data-log-row]')).toHaveCount(4);
        await scroller.focus();
        await page.keyboard.press('Enter');
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Enter');
        await expect(heading(page)).toHaveText('checkout logs');
        await expect(heading(page)).toBeFocused();
        await expect(
          current(page).locator('[data-fact]').filter({ hasText: 'Time' }).first(),
        ).toHaveText('Time1795095725250000000 ns');
        const names: string[] = [];
        for (let i = 0; i < 12; i++) {
          await page.keyboard.press('Tab');
          names.push(
            await page.evaluate(() => {
              const a = document.activeElement;
              return a?.getAttribute('aria-label') ?? a?.textContent.trim() ?? '';
            }),
          );
        }
        expect(names).toEqual([
          'Collapse Inspector',
          'Close Inspector',
          'Copy value',
          'Explore',
          'Logs ±1 min',
          'Traces',
          'Profiles',
          'Entity',
          'Label filter',
          'Copy query',
          'Edit query',
          'Pin',
        ]);
        for (const [id, reason] of [
          ['traces', 'Traces are not available yet'],
          ['profiles', 'Profiles are not available yet'],
          ['entity', 'The entity catalogue is not available yet'],
          ['labelFilter', 'Filtering Explore by a label arrives with label filters'],
        ] as const) {
          const chip = current(page).locator(`[data-pivot="${id}"]`);
          const described = await chip.getAttribute('aria-describedby');
          await expect(page.locator(`[id="${described ?? ''}"]`)).toContainText(reason);
        }
        await expect(page.locator('[data-inspector-live]')).toHaveText(
          'Inspector: checkout logs, warning log line at 13:42:05',
        );
      },
    );
  });

  test('e2e:selection-sources', async ({ page, request, browserName }) => {
    test.setTimeout(90_000);
    await withBoard(
      page,
      request,
      'inspector selection',
      SELECTION,
      (u) => boardUrl(u, S_FROM, S_TO),
      async () => {
        const b = panel(page, 'b').locator('[data-chart-frame]');
        await expect(panel(page, 'b').locator('[data-frame-ready="true"]')).toHaveCount(1);
        const none = await b.screenshot();
        const toggle = panel(page, 'a').getByRole('button', {
          name: /^Select inspector_two\{series="k1"\}/,
        });
        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-pressed', 'true');
        const keys = await panel(page, 'a')
          .locator('[data-chart-frame]')
          .getAttribute('data-selection-keys');
        expect(keys).not.toBe('');
        await expect(b).toHaveAttribute('data-selection-keys', keys ?? '');
        await expect(page.locator('[data-inspector]')).toHaveCount(0);
        await page.evaluate(
          () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
        );
        const selected = await b.screenshot();
        expect(selected.equals(none)).toBe(false);
        if (browserName === 'chromium') await expect(b).toHaveScreenshot('selection-b.png');
        await toggle.click();
        await expect(b).toHaveAttribute('data-selection-keys', '');
        await page.evaluate(
          () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
        );
        if (browserName === 'chromium') await expect(b).toHaveScreenshot('selection-none.png');
      },
    );
  });

  test('e2e:selection-logs', async ({ page, request }) => {
    test.setTimeout(120_000);
    await withBoard(
      page,
      request,
      'inspector logs',
      LOGS_BOARD,
      (u) => boardUrl(u, S_FROM, S_TO),
      async () => {
        const rows = (id: string) => panel(page, id).locator('[data-log-row]');
        const line = (id: string, text: string) => rows(id).filter({ hasText: text });
        await expect(rows('l1')).toHaveCount(3);
        await expect(rows('l2')).toHaveCount(3);
        const state = async (id: string) =>
          rows(id).evaluateAll((els) =>
            els.map(
              (el) =>
                `${el.querySelector('[data-log-line]')?.textContent ?? ''}:${el.hasAttribute('data-selected') ? 'sel' : el.hasAttribute('data-muted') ? 'mute' : '-'}`,
            ),
          );
        // (a) The s1 row at 12:00:10 in L1: the other s1 row and the s2 row are muted (T25 §10).
        await line('l1', 's1 line at 12:00:10').click();
        for (const id of ['l1', 'l2']) {
          await expect
            .poll(() => state(id))
            .toEqual([
              's1 line at 12:00:40:mute',
              's2 line at 12:00:20:mute',
              's1 line at 12:00:10:sel',
            ]);
        }
        const bFrame = panel(page, 'b').locator('[data-chart-frame]');
        await expect(bFrame).not.toHaveAttribute('data-selection-keys', '');
        // (b) Esc twice restores every row.
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
        for (const id of ['l1', 'l2']) {
          await expect
            .poll(() => state(id))
            .toEqual(['s1 line at 12:00:40:-', 's2 line at 12:00:20:-', 's1 line at 12:00:10:-']);
        }
        // (c) H's bucket [12:00:00, 12:00:30).
        await clickAt(page, await plotPoint(page, 'h', S_FROM + 15_000, 0.5, S_FROM, S_TO));
        await expect(heading(page)).toHaveText('H');
        for (const id of ['l1', 'l2']) {
          await expect
            .poll(() => state(id))
            .toEqual([
              's1 line at 12:00:40:mute',
              's2 line at 12:00:20:sel',
              's1 line at 12:00:10:sel',
            ]);
        }
        // (d) The s2 row in L2: only it, in L1 too.
        // The right-hand panel's row, left of the open sheet (it floats over the content).
        await line('l2', 's2 line at 12:00:20').click({ position: { x: 40, y: 10 } });
        for (const id of ['l1', 'l2']) {
          await expect
            .poll(() => state(id))
            .toEqual([
              's1 line at 12:00:40:mute',
              's2 line at 12:00:20:sel',
              's1 line at 12:00:10:mute',
            ]);
        }
        // (e) Select k1 in B's legend: a foreign key selects and mutes nothing.
        await panel(page, 'b')
          .getByRole('button', { name: /^Select inspector_two\{series="k1"\}/ })
          .click();
        for (const id of ['l1', 'l2']) {
          await expect
            .poll(() => state(id))
            .toEqual(['s1 line at 12:00:40:-', 's2 line at 12:00:20:-', 's1 line at 12:00:10:-']);
        }
      },
    );
  });

  test('e2e:pivot-destination', async ({ page, request }) => {
    test.setTimeout(120_000);
    const since = Date.now();
    await withBoard(
      page,
      request,
      'inspector kinds',
      KINDS,
      (u) => boardUrl(u, K_FROM, K_TO, '&f=env%3Dprod'),
      async () => {
        await inspectP(page);
        const explore = current(page).locator('a[data-pivot="explore"]');
        await expect(explore.locator('xpath=..')).toContainText(
          'Filters not applied in Explore yet: env',
        );
        const exploreHref = (await explore.getAttribute('href')) ?? '';
        await current(page).locator('a[data-pivot="logs"]').click();
        await expect(page).toHaveURL(/\/explore\/logs\?/);
        await expect(page.locator('[data-log-row]')).toHaveCount(1);
        await expect(page.locator('[data-log-row]')).toContainText('prod: payment authorisation');
        const sent = await fakeRequests(request, { path: '/api/logs/v1/query_range' });
        const mine = sent.filter((r) => r.receivedAtMs >= since && r.query.includes('env="prod"'));
        expect(mine.length).toBeGreaterThan(0);
        expect(mine[0]?.query).toContain('service_name="checkout"');
        await page.goBack();
        await inspectP(page);
        await current(page).locator('a[data-pivot="explore"]').click();
        await expect(page).toHaveURL(/\/explore\/metrics\?/);
        const u = new URL(page.url());
        expect(u.searchParams.get('q')).toBe(P99);
        expect(u.searchParams.has('f')).toBe(false);
        expect(new URL(exploreHref, 'http://x').searchParams.get('q')).toBe(P99);
      },
    );
  });

  test('e2e:inspector-motion', async ({ browser, request }) => {
    test.setTimeout(120_000);
    for (const reducedMotion of ['reduce', 'no-preference'] as const) {
      const ctx = await browser.newContext({
        baseURL: HTTP_BFF,
        viewport: { width: 1440, height: 900 },
        reducedMotion,
      });
      const page = await ctx.newPage();
      try {
        await withBoard(
          page,
          request,
          'inspector kinds',
          KINDS,
          (u) => boardUrl(u, K_FROM, K_TO),
          async () => {
            // The sheet's computed state in the first animation frame after the next pointer or
            // key gesture: armed in the page before the gesture, so a slow round trip cannot let
            // a 150 ms transition end before it is read.
            interface Probe {
              present: boolean;
              opacity: string;
              translate: string;
              duration: string;
              layers: number;
              layerDuration: string;
            }
            const arm = (type: 'pointerup' | 'keyup', frame = true) =>
              page.evaluate(
                ([t, f]) => {
                  const w = window as unknown as { __probe: Probe | null };
                  w.__probe = null;
                  document.addEventListener(
                    t,
                    () => {
                      // After React's commit of the gesture (a task), then the next frame.
                      setTimeout(() => {
                        const later = (cb: () => void): void => {
                          if (f) requestAnimationFrame(cb);
                          else cb();
                        };
                        later(() => {
                          const a = document.querySelector<HTMLElement>('[data-inspector]');
                          const layer = document.querySelector<HTMLElement>(
                            '[data-inspector-content]',
                          );
                          const st = a === null ? null : getComputedStyle(a);
                          w.__probe = {
                            present: a !== null,
                            opacity: st?.opacity ?? '',
                            translate: st?.translate ?? '',
                            duration: st?.transitionDuration ?? '',
                            layers: document.querySelectorAll('[data-inspector-content]').length,
                            layerDuration:
                              layer === null ? '' : getComputedStyle(layer).transitionDuration,
                          };
                        });
                      }, 0);
                    },
                    { capture: true, once: true },
                  );
                },
                [type, frame] as const,
              );
            const read = async (): Promise<Probe> => {
              await expect
                .poll(() =>
                  page.evaluate(() => (window as unknown as { __probe: unknown }).__probe),
                )
                .not.toBeNull();
              return page.evaluate(() => (window as unknown as { __probe: Probe }).__probe);
            };
            const at = await plotPoint(page, 'p1', P_T, 0.12, K_FROM, K_TO);
            const at2 = await plotPoint(page, 'p1', P_T - 60_000, 0.12, K_FROM, K_TO);
            await arm('pointerup');
            await page.mouse.click(at.x, at.y);
            const open = await read();
            await arm('pointerup');
            await page.mouse.click(at2.x, at2.y);
            const change = await read();
            await page.keyboard.press('Escape');
            // Read right after the close's commit: a slow engine may skip frames for 150 ms.
            await arm('keyup', false);
            await page.keyboard.press('Escape');
            const closed = await read();
            if (reducedMotion === 'reduce') {
              expect(open.opacity).toBe('1');
              expect(open.translate).toBe('none');
              expect(change.layers).toBe(1);
              expect(closed.present).toBe(false);
            } else {
              expect(open.duration).toContain('0.2s');
              expect(change.layers).toBe(2);
              expect(change.layerDuration).toBe('0.15s');
              expect(closed.present).toBe(true);
              await expect(page.locator('[data-inspector]')).toHaveCount(0, { timeout: 500 });
            }
          },
        );
      } finally {
        await ctx.close();
      }
    }
  });

  test('golden:inspector', async ({ page, request, browserName }) => {
    test.skip(browserName !== 'chromium', 'pixel goldens are Chromium only');
    test.setTimeout(120_000);
    await withBoard(
      page,
      request,
      'inspector kinds',
      KINDS,
      (u) => boardUrl(u, K_FROM, K_TO),
      async () => {
        for (const theme of ['dark', 'light', 'forced'] as const) {
          if (theme === 'forced') await page.emulateMedia({ forcedColors: 'active' });
          else {
            await page.emulateMedia({ forcedColors: 'none' });
            await page.evaluate((t) => {
              document.documentElement.dataset['theme'] = t;
            }, theme);
          }
          await inspectP(page);
          const sheet = aside(page);
          if (theme === 'forced') {
            const bg = await sheet.evaluate((el) => getComputedStyle(el).backgroundColor);
            expect(bg).not.toMatch(/rgba\(.*, 0(\.\d+)?\)$/);
          }
          await expect(sheet).toHaveScreenshot(`inspector-open-${theme}.png`, {
            animations: 'disabled',
          });
          await sheet.getByRole('button', { name: 'Collapse Inspector' }).click();
          await expect(aside(page)).toHaveAttribute('data-collapsed', '');
          await expect(aside(page)).toHaveScreenshot(`inspector-collapsed-${theme}.png`, {
            animations: 'disabled',
          });
          await aside(page).getByRole('button', { name: 'Expand Inspector' }).click();
        }
      },
    );
  });
});
