/**
 * The Explore metrics page against the PulsusDB fake through the http-mode BFF (plan #63 Part C
 * Appendix C.4): completion, auto-vis, errors on run, the series table, cancellation, truncation and
 * refresh; and, on the stub build, that the editor chunk loads only with the page (`e2e:lazy-load`).
 * Each browser counts requests in its own windows, so parallel projects never match each other's
 * records, and no test resets the fake.
 */
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { HTTP_BFF, NEEDS_BFF, PREVIEW } from './bff.ts';
import { fakeRequests, sec } from './fake.ts';
import { open, searchOf, timeTrigger, waitReady } from './helpers.ts';

const W0 = Date.UTC(2026, 0, 1);
const HOUR = 3_600_000;
const MIN = 60_000;

function exploreUrl(q: string | null, fromMs = W0, toMs = W0 + HOUR, extra = ''): string {
  const iso = (ms: number) => encodeURIComponent(new Date(ms).toISOString());
  const qs = q === null ? '' : `&q=${encodeURIComponent(q)}`;
  return `/t/demo/explore/metrics?from=${iso(fromMs)}&to=${iso(toMs)}&refresh=off${qs}${extra}`;
}

const canvas = (page: Page) => page.locator('[data-chart-frame] canvas');
const editor = (page: Page) => page.getByRole('textbox', { name: 'PromQL query' });
const popup = (page: Page) => page.locator('.cm-tooltip-autocomplete');
const ready = (page: Page) => page.locator('[data-chart-frame][data-frame-ready="true"]');
const label = (page: Page) => canvas(page).getAttribute('aria-label');
const statusLine = (page: Page) =>
  page.getByRole('status').filter({ hasText: /^(\d+ series|Scalar|String) · / });

/** The project's index among the three browsers: its own windows for counting requests. */
function idx(info: TestInfo): number {
  return Math.max(0, ['chromium', 'firefox', 'webkit'].indexOf(info.project.name));
}

test.describe('e2e:explore (fake)', () => {
  test.skip(PREVIEW, NEEDS_BFF);
  test.use({ baseURL: HTTP_BFF });

  test('e2e:explore-completion', async ({ page }) => {
    // A running clock: CodeMirror accepts an option only once `Date.now()` is 75 ms past the
    // popup's opening (`interactionDelay`), which a frozen clock never reaches. The window is
    // absolute, so the page does not depend on the time.
    await page.goto(exploreUrl(null));
    await waitReady(page, exploreUrl(null));
    await editor(page).click();
    await page.keyboard.type('http_requests_tot');
    const option = popup(page).getByRole('option').filter({ hasText: 'http_requests_total' });
    await expect(option).toBeVisible();
    await expect(option.locator('.cm-completionDetail')).toHaveText('counter');
    await page.waitForTimeout(150);
    await page.keyboard.press('Enter');
    await expect(editor(page)).toHaveText('http_requests_total');
  });

  test('e2e:metrics-autovis counter', async ({ page, request }) => {
    // e2e:explore-sends-inputs (plan #112, T06-029): the page sends the raw text and the rate
    // chip; the server plans the rewrite and sends it to PulsusDB.
    const sent = page.waitForRequest(
      (r) => r.method() === 'POST' && r.url().includes('/api/dash/v1/query/promql/range'),
    );
    await open(page, exploreUrl('http_requests_total'));
    const body = (await sent).postDataJSON() as { query?: unknown; rate?: unknown };
    expect(body.query).toBe('http_requests_total');
    expect(body.rate).toBe(true);
    await expect(ready(page)).toBeVisible();
    await expect
      .poll(
        async () =>
          (
            await fakeRequests(request, {
              path: '/api/v1/query_range',
              query: 'rate(http_requests_total[1m])',
              state: 'completed',
            })
          ).length,
      )
      .toBeGreaterThanOrEqual(1);
    const width = await page
      .locator('[data-chart-frame]')
      .locator('..')
      .evaluate((e) => e.clientWidth);
    expect(width).toBeGreaterThanOrEqual(720);
    expect(width).toBeLessThanOrEqual(3599);
    await expect.poll(() => label(page)).toMatch(/^Query result: line chart, 2 series/);
    const chip = page.getByRole('button', { name: 'Rate applied' });
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('Sent query: rate(http_requests_total[1m])')).toBeVisible();
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => searchOf(page)['rate']).toBe('off');
    await expect(page.getByText(/^Sent query:/)).toHaveCount(0);
    await expect.poll(() => label(page)).toMatch(/^Query result: line chart, 2 series/);
    await expect
      .poll(
        async () =>
          (
            await fakeRequests(request, {
              path: '/api/v1/query_range',
              query: 'http_requests_total',
              state: 'completed',
            })
          ).length,
      )
      .toBeGreaterThanOrEqual(1);
  });

  test('e2e:metrics-autovis histogram', async ({ page }) => {
    await open(page, exploreUrl('sum by (le) (rate(http_request_duration_seconds_bucket[5m]))'));
    await expect(ready(page)).toBeVisible();
    await expect.poll(() => label(page)).toMatch(/^Query result: heatmap,/);
    await expect(page.getByRole('radio', { name: 'Auto (Heatmap)' })).toBeChecked();
  });

  test('e2e:metrics-autovis scalar', async ({ page, request }) => {
    await open(page, exploreUrl('scalar(vector(1)) / 0'));
    await expect(ready(page)).toBeVisible();
    await expect.poll(() => label(page)).toMatch(/^Query result: stat/);
    await expect(page.getByRole('radio', { name: 'Auto (Stat)' })).toBeChecked();
    const rows = page.getByRole('table').getByRole('row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(1).getByRole('cell').first()).toHaveText('scalar');
    const recs = await fakeRequests(request, {
      path: '/api/v1/query',
      query: 'scalar(vector(1)) / 0',
    });
    expect(recs.length).toBeGreaterThanOrEqual(1);
  });

  test('e2e:editor-error-on-run', async ({ page }) => {
    await open(page, exploreUrl('node_memory_free_bytes'));
    await expect(ready(page)).toBeVisible();
    await editor(page).click();
    await page.keyboard.press('ControlOrMeta+A');
    // Clear first: in Firefox, text inserted right after a click and select-all can land before the
    // selection CodeMirror has not read yet.
    await page.keyboard.press('Backspace');
    await page.keyboard.insertText('rate(http_server_duration_bucket{service="checkout"[5m])');
    await page.keyboard.press('Shift+Enter');
    await expect(page.locator('.cm-lintRange-error')).toHaveText('[');
    await expect(page.getByRole('alert')).toContainText(
      'parse error: unexpected "[" in label matching, expected string',
    );
    expect(await label(page)).toContain('3 series');
    await editor(page).click();
    await page.keyboard.press('ControlOrMeta+A');
    // Clear first: in Firefox, text inserted right after a click and select-all can land before the
    // selection CodeMirror has not read yet.
    await page.keyboard.press('Backspace');
    await page.keyboard.insertText('sum(up');
    await page.keyboard.press('Shift+Enter');
    await expect(page.locator('.cm-lintRange-error')).toHaveText('sum(up');
    await expect(page.getByRole('alert')).toHaveText(/\(position unknown\)$/);
  });

  test('e2e:series-table', async ({ page }) => {
    await open(page, exploreUrl('node_memory_free_bytes'));
    await expect(ready(page)).toBeVisible();
    const table = page.getByRole('table');
    await table.getByRole('button', { name: 'Max' }).click();
    const first = table.getByRole('row').nth(1).getByRole('button');
    await expect(first).toHaveText('node_memory_free_bytes{instance="a:9100"}');
    await first.click();
    await expect.poll(() => label(page)).toContain('1 series');
    await expect(first).toHaveAttribute('aria-pressed', 'true');
    await first.click();
    await expect.poll(() => label(page)).toContain('3 series');
    await expect(first).toHaveAttribute('aria-pressed', 'false');
  });

  test('e2e:explore-cancel', async ({ page, request }, info) => {
    const A = Date.UTC(2026, 0, 2 + idx(info));
    const B = A + HOUR;
    const C = B + HOUR;
    await open(page, exploreUrl('slow_metric', A, A + HOUR));
    await expect(statusLine(page)).toHaveText(/^0 series · step 5 s/, { timeout: 5_000 });
    await page.locator('h1').click();
    const t0 = Date.now();
    await page.keyboard.press(']');
    await expect
      .poll(
        () =>
          fakeRequests(request, {
            path: '/api/v1/query_range',
            query: 'slow_metric',
            start: sec(B),
          }),
        { intervals: [10], timeout: 150 },
      )
      .toHaveLength(1);
    await page.keyboard.press(']');
    expect(Date.now() - t0).toBeLessThanOrEqual(200);
    await expect
      .poll(
        async () => {
          const at = async (start: number) =>
            (
              await fakeRequests(request, {
                path: '/api/v1/query_range',
                query: 'slow_metric',
                start: sec(start),
              })
            ).map((r) => r.state);
          return { b: await at(B), c: await at(C) };
        },
        { timeout: 6_000 },
      )
      .toEqual({ b: ['cancelled'], c: ['completed'] });
    await expect(timeTrigger(page)).toContainText('02:00');
    await expect(statusLine(page)).toHaveText(/^0 series/);
  });

  test('e2e:explore-truncation', async ({ page, request }, info) => {
    const T = Date.UTC(2026, 2, 1 + idx(info));
    await open(page, exploreUrl('topk(1000, up)', T, T + HOUR));
    const box = page.getByRole('status', { name: 'Query notices' });
    await expect(box).toContainText('Partial data');
    await expect(box).toContainText('results truncated due to limit');
    await box.getByRole('button', { name: 'Narrow the time range' }).click();
    await expect.poll(() => searchOf(page)['from']).toBe(new Date(T + 15 * MIN).toISOString());
    expect(searchOf(page)['to']).toBe(new Date(T + 45 * MIN).toISOString());
    await expect
      .poll(
        async () =>
          (
            await fakeRequests(request, {
              query: 'topk(1000, up)',
              start: sec(T + 15 * MIN),
              state: 'completed',
            })
          ).length,
      )
      .toBeGreaterThanOrEqual(1);

    await open(page, exploreUrl('{__name__=~".+"}', T, T + HOUR));
    const alert = page.getByRole('alert');
    await alert.getByRole('button', { name: 'Narrow the time range' }).click();
    await expect
      .poll(
        async () =>
          (await fakeRequests(request, { query: '{__name__=~".+"}', start: sec(T + 15 * MIN) }))
            .length,
      )
      .toBeGreaterThanOrEqual(1);
  });

  test('e2e:explore-refresh', async ({ page, request }, info) => {
    const R = Date.UTC(2026, 1, 1 + idx(info));
    await open(page, exploreUrl('empty_metric', R, R + HOUR));
    await expect(statusLine(page)).toHaveText(/^0 series/);
    await page.getByRole('button', { name: 'Refresh now' }).click();
    await expect
      .poll(
        async () =>
          (
            await fakeRequests(request, {
              query: 'empty_metric',
              start: sec(R),
              state: 'completed',
            })
          ).length,
      )
      .toBe(2);
  });
});

test.describe('e2e:lazy-load explore', () => {
  test('the editor chunk loads with Explore only, once', async ({ page }) => {
    const editorUrls: string[] = [];
    page.on('request', (r) => {
      if (/\/assets\/editor-[^/]+\.js$/.test(new URL(r.url()).pathname)) editorUrls.push(r.url());
    });
    await open(page, '/t/demo/boards');
    await waitReady(page, '/t/demo/boards');
    expect(editorUrls).toEqual([]);
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Metrics', exact: true })
      .click();
    await expect(editor(page)).toBeVisible();
    expect(editorUrls.length).toBeGreaterThanOrEqual(1);
    expect(new Set(editorUrls).size).toBe(editorUrls.length);
  });

  test('a board loads the editor chunk for its PromQL panels, once', async ({ page }) => {
    // Board panels read the query shape through the language module (plan #64 R4).
    const editorUrls: string[] = [];
    page.on('request', (r) => {
      if (/\/assets\/editor-[^/]+\.js$/.test(new URL(r.url()).pathname)) editorUrls.push(r.url());
    });
    await open(page, '/t/demo/boards');
    expect(editorUrls).toEqual([]);
    await open(page, '/t/demo/board/b-1');
    // Request rate and Error ratio: Request latency, below the fold, does not query (T07-012).
    await expect(page.locator('[data-chart-frame][data-frame-ready="true"]')).toHaveCount(2);
    expect(editorUrls.length).toBeGreaterThanOrEqual(1);
    expect(new Set(editorUrls).size).toBe(editorUrls.length);
  });
});

test.describe('e2e:explore-picker-inert', () => {
  // On the http BFF, so a Run is a request the page makes (the stub answers in the page).
  test.skip(PREVIEW, NEEDS_BFF);
  test.use({ baseURL: HTTP_BFF });

  test('the page is inert while the metric list is open', async ({ page }) => {
    const ranges: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/dash/v1/query/promql/range')) ranges.push(r.url());
    });
    await open(page, exploreUrl('http_requests_total'));
    // The fake's counter-rate transcript: two series.
    await expect(page.getByRole('table').getByRole('row')).toHaveCount(3);
    const run = page.getByRole('button', { name: 'Run' });
    await expect(run).toBeEnabled();
    const inert = page.locator('[inert]');
    await expect(inert).toHaveCount(0);
    const picker = page.getByRole('combobox', { name: 'Metric' });
    const list = page.getByRole('listbox');
    // Taken before the list opens: while it is open React Aria hides Run from role queries.
    const runEl = await run.elementHandle();
    const underInert = (l: typeof run) => l.evaluate((e) => e.closest('[inert]') !== null);

    // P1: open on focus; everything else is inert.
    await picker.focus();
    await expect(list).toBeVisible();
    await expect.poll(() => inert.count()).toBeGreaterThanOrEqual(1);
    expect(await runEl.evaluate((e) => e.closest('[inert]') !== null)).toBe(true);
    expect(await underInert(picker)).toBe(false);
    expect(await underInert(list)).toBe(false);

    // P2: Tab releases and moves on to Run.
    await page.keyboard.press('Tab');
    await expect(run).toBeFocused();
    await expect(list).toHaveCount(0);
    await expect(inert).toHaveCount(0);

    // P3: Shift+Tab releases and moves back.
    await picker.focus();
    await expect(list).toBeVisible();
    await page.keyboard.press('Shift+Tab');
    await expect(list).toHaveCount(0);
    await expect(inert).toHaveCount(0);
    expect(
      await page.evaluate(
        () =>
          document.activeElement !== document.body &&
          document.activeElement?.closest('[inert]') === null,
      ),
    ).toBe(true);

    // P4: Escape closes; focus stays on the picker.
    await picker.focus();
    await expect(list).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(picker).toBeFocused();
    await expect(inert).toHaveCount(0);

    // P5: a press on the inert Run only closes the list; a second press runs.
    await picker.evaluate((e) => {
      (e as HTMLElement).blur();
    });
    await picker.focus();
    await expect(list).toBeVisible();
    const b = await runEl.boundingBox();
    if (b === null) throw new Error('no Run box');
    const press = async () => {
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await page.mouse.down();
      await page.mouse.up();
    };
    const before = ranges.length;
    await press();
    await expect(list).toHaveCount(0);
    await expect(inert).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(ranges.length).toBe(before);
    await press();
    await expect.poll(() => ranges.length).toBe(before + 1);

    // P6: picking a name releases before the editor takes the focus.
    await picker.focus();
    await expect(list).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('textbox', { name: 'PromQL query' })).toBeFocused();
    await expect(inert).toHaveCount(0);
  });
});
