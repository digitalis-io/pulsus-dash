/**
 * Explore › Logs against the PulsusDB fake through the http-mode BFF (plan #66 Part C §5.3):
 * completion, a stream run with its volume, the brush, paging, a metric query, cancellation,
 * partial data, refresh and an error on run; and, on the stub build, that the LogQL editor chunk
 * loads only with the page (`e2e:lazy-load logs`). The page's requests are read in the browser; the
 * fake's records only where its state is the assertion, each browser in its own windows.
 */
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { HTTP_BFF, NEEDS_BFF, PREVIEW } from './bff.ts';
import { fakeRequests, runShift } from './fake.ts';
import { brushTargets, ns, open, searchOf, timeTrigger, waitReady } from './helpers.ts';

/** 2026-01-01T12:00Z: the window of the log transcripts (§3.13). */
const L0 = Date.UTC(2026, 0, 1, 12);
const HOUR = 3_600_000;
const MIN = 60_000;
const RANGE = '/api/dash/v1/query/logql/range';
const VOLUME = '/api/dash/v1/query/logql/volume';

function logsUrl(q: string | null, fromMs = L0, toMs = L0 + HOUR, extra = ''): string {
  const iso = (ms: number) => encodeURIComponent(new Date(ms).toISOString());
  const qs = q === null ? '' : `&q=${encodeURIComponent(q)}`;
  return `/t/demo/explore/logs?from=${iso(fromMs)}&to=${iso(toMs)}&refresh=off${qs}${extra}`;
}

interface RangeBody {
  query: string;
  from: number;
  to: number;
  width_px: number;
  cursor?: string;
  direction?: string;
}
interface VolumeBody {
  query: string;
  from: number;
  to: number;
  width_px: number;
}

/** The page's range and volume request bodies, from the browser, in order. */
function bodies(page: Page): { range: RangeBody[]; volume: VolumeBody[] } {
  const out = { range: [] as RangeBody[], volume: [] as VolumeBody[] };
  page.on('request', (r) => {
    if (r.method() !== 'POST') return;
    const path = new URL(r.url()).pathname;
    if (path === RANGE) out.range.push(r.postDataJSON() as RangeBody);
    if (path === VOLUME) out.volume.push(r.postDataJSON() as VolumeBody);
  });
  return out;
}

/** A layout change moves the step off the transcripts' 5 s: fail with this message, not a 404. */
function widthChecked(b: RangeBody | undefined): void {
  expect(b, 'a range request').toBeDefined();
  const w = b?.width_px ?? 0;
  expect(w, 'width_px gives step 5 s on 1 h (720 ≤ w < 3600)').toBeGreaterThanOrEqual(720);
  expect(w, 'width_px gives step 5 s on 1 h (720 ≤ w < 3600)').toBeLessThan(3600);
}

const editor = (page: Page) => page.getByRole('textbox', { name: 'LogQL query' });
const popup = (page: Page) => page.locator('.cm-tooltip-autocomplete');
const list = (page: Page) => page.getByRole('list', { name: 'Log lines' });
const rows = (page: Page) => list(page).locator('[data-log-row]');
const volumeFrame = (page: Page) => page.locator('[data-chart-frame]');
const ready = (page: Page) => page.locator('[data-chart-frame][data-frame-ready="true"]');
const summary = (page: Page) => volumeFrame(page).locator('canvas').getAttribute('aria-label');

/** The card titled `name`. */
function card(page: Page, name: string): Locator {
  return page.locator('section', { has: page.getByRole('heading', { level: 2, name }) });
}

/** What a screen reader reads for a row: its text without the `aria-hidden` parts. */
function spoken(row: Locator): Promise<string> {
  return row.evaluate((el) => {
    const parts: string[] = [];
    const walk = (n: Node): void => {
      if (n instanceof Element && n.getAttribute('aria-hidden') === 'true') return;
      if (n.nodeType === Node.TEXT_NODE) parts.push(n.textContent ?? '');
      for (const c of n.childNodes) walk(c);
    };
    for (const c of el.childNodes) {
      const before = parts.length;
      walk(c);
      if (parts.length > before) parts.push(' ');
    }
    return parts.join('').replace(/\s+/g, ' ').trim();
  });
}

/** The project's index among the three browsers: its own windows for the fake's records. */
function idx(info: TestInfo): number {
  return Math.max(0, ['chromium', 'firefox', 'webkit'].indexOf(info.project.name));
}

test.describe('e2e:logs (fake)', () => {
  test.skip(PREVIEW, NEEDS_BFF);
  test.use({ baseURL: HTTP_BFF });

  test('e2e:logs-completion', async ({ page }) => {
    // A running clock, as e2e:explore-completion: CodeMirror accepts an option only once the
    // popup's interaction delay has passed. The window is absolute.
    await page.goto(logsUrl(null));
    await waitReady(page, logsUrl(null));
    await editor(page).click();
    await page.keyboard.type('{app="');
    for (const v of ['checkout', 'paging', 'slow']) {
      await expect(popup(page).getByRole('option').filter({ hasText: v })).toBeVisible();
    }
    await page.waitForTimeout(150);
    await page.keyboard.press('Enter');
    await expect(editor(page)).toHaveText(/^\{app="checkout"/);
  });

  test('e2e:logs-run', async ({ page }) => {
    const b = bodies(page);
    await open(page, logsUrl('{app="checkout"}'));
    await expect.poll(() => b.range.length).toBeGreaterThanOrEqual(1);
    widthChecked(b.range[0]);
    expect(b.range[0]).toMatchObject({ query: '{app="checkout"}', from: L0, to: L0 + HOUR });
    expect(b.range[0]?.cursor).toBeUndefined();
    await expect.poll(() => b.volume.length).toBe(1);
    expect(b.volume[0]).toMatchObject({ query: '{app="checkout"}', from: L0, to: L0 + HOUR });
    await expect(ready(page)).toBeVisible();
    await expect.poll(() => summary(page)).toMatch(/^Log volume: stacked bar chart, 2 series/);
    await expect(rows(page)).toHaveCount(6);
    expect(await spoken(rows(page).first())).toMatch(/^Error .* checkout line F$/);
  });

  test('e2e:logs-brush', async ({ page }) => {
    const b = bodies(page);
    await open(page, logsUrl('{app="checkout"}'));
    await expect(rows(page)).toHaveCount(6);
    await expect.poll(() => summary(page)).toMatch(/^Log volume: stacked bar chart, 2 series/);
    widthChecked(b.range[0]);
    const { x1, x2, y } = await brushTargets(page, volumeFrame(page), L0, L0 + HOUR);
    await page.mouse.move(x1, y);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(x2, y, { steps: 10 });
    await page.mouse.up({ button: 'right' });
    await expect
      .poll(() => searchOf(page))
      .toMatchObject({ from: '2026-01-01T12:20:00.000Z', to: '2026-01-01T12:25:00.000Z' });
    const lo = L0 + 20 * MIN;
    const hi = L0 + 25 * MIN;
    await expect.poll(() => b.range.some((r) => r.from === lo && r.to === hi)).toBe(true);
    await expect.poll(() => b.volume.some((r) => r.from === lo && r.to === hi)).toBe(true);
    await expect(rows(page)).toHaveCount(2);
    await expect(rows(page).nth(0).locator('[data-log-line]')).toHaveText('checkout line D');
    await expect(rows(page).nth(1).locator('[data-log-line]')).toHaveText('checkout line C');
    await expect(ready(page)).toBeVisible();
    await expect.poll(() => summary(page)).toMatch(/^Log volume: stacked bar chart, 2 series/);
  });

  test('e2e:logs-paging', async ({ page }) => {
    test.setTimeout(120_000);
    const b = bodies(page);
    await open(page, logsUrl('{app="paging"}'));
    await expect(rows(page).first()).toBeVisible();
    widthChecked(b.range[0]);
    const region = page.locator('[data-log-scroller]');
    await region.scrollIntoViewIfNeeded();
    const box = await region.boundingBox();
    if (box === null) throw new Error('no Log lines region');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const seen = new Map<number, string>();
    const end = page.getByText('End of results');
    let lastSetSize = '';
    for (let i = 0; i < 400; i++) {
      const mounted = await rows(page).evaluateAll((els) =>
        els.map((e) => [
          Number(e.getAttribute('data-ord')),
          e.querySelector('[data-log-line]')?.textContent ?? '',
          e.getAttribute('aria-setsize') ?? '',
        ]),
      );
      for (const [ord, line, size] of mounted as [number, string, string][]) {
        seen.set(ord, line);
        if (ord === 1499) lastSetSize = size;
      }
      if (seen.has(1499) && (await end.isVisible())) break;
      await page.mouse.wheel(0, 600);
      await page.waitForTimeout(30);
    }
    await expect(end).toBeVisible();
    expect(b.range).toHaveLength(2);
    expect(b.range[0]?.cursor).toBeUndefined();
    expect(b.range[1]?.cursor).toEqual(expect.any(String));
    expect(seen.size).toBe(1500);
    const bad: string[] = [];
    for (let k = 0; k < 1500; k++) {
      const want = `paging line ${String(k).padStart(4, '0')}`;
      if (seen.get(k) !== want) bad.push(`${String(k)}: ${seen.get(k) ?? 'missing'}`);
    }
    expect(bad).toEqual([]);
    expect(lastSetSize).toBe('1500');
  });

  test('e2e:logs-metric', async ({ page }) => {
    await open(page, logsUrl('sum by (level) (count_over_time({app="checkout"}[1m]))'));
    await expect(ready(page)).toBeVisible();
    await expect.poll(() => summary(page)).toMatch(/^Query result: line chart, 2 series/);
    await expect(list(page)).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 2, name: 'Volume' })).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('e2e:logs-cancel', async ({ page, request }, info) => {
    const A = Date.UTC(2026, 0, 2 + idx(info)) + runShift(info);
    const B = A + HOUR;
    const C = B + HOUR;
    await open(page, logsUrl('{app="slow"}', A, A + HOUR));
    await expect(page.getByText(/^0 log lines · newest first$/)).toBeVisible({ timeout: 5_000 });
    await page.locator('h1').click();
    const t0 = Date.now();
    await page.keyboard.press(']');
    const range = '/api/logs/v1/query_range';
    await expect
      .poll(() => fakeRequests(request, { path: range, query: '{app="slow"}', start: ns(B) }), {
        intervals: [10],
        timeout: 150,
      })
      .toHaveLength(1);
    await page.keyboard.press(']');
    expect(Date.now() - t0).toBeLessThanOrEqual(200);
    const vol =
      'sum by (level, detected_level) (count_over_time({app="slow"}\n| drop __error__ [5s]))';
    const at = async (query: string, start: number) =>
      (await fakeRequests(request, { path: range, query, start: ns(start) })).map((r) => r.state);
    await expect
      .poll(
        async () => ({
          b: await at('{app="slow"}', B),
          c: await at('{app="slow"}', C),
          vb: await at(vol, B),
          vc: await at(vol, C),
        }),
        { timeout: 6_000 },
      )
      .toEqual({ b: ['cancelled'], c: ['completed'], vb: ['cancelled'], vc: ['completed'] });
    await expect(timeTrigger(page)).toContainText(new Date(C).toISOString().slice(11, 16));
  });

  test('e2e:logs-truncation', async ({ page }, info) => {
    const T = Date.UTC(2026, 2, 1 + idx(info), 12);
    const b = bodies(page);
    await open(page, logsUrl('{app="truncated"}', T, T + HOUR));
    const notice = card(page, 'Log lines').getByRole('status', { name: 'Query notices' });
    await expect(notice).toContainText('Partial data');
    await expect(notice).toContainText('results truncated due to limit');
    await notice.getByRole('button', { name: 'Narrow the time range' }).click();
    await expect.poll(() => searchOf(page)['from']).toBe(new Date(T + 15 * MIN).toISOString());
    expect(searchOf(page)['to']).toBe(new Date(T + 45 * MIN).toISOString());
    await expect
      .poll(() => b.range.some((r) => r.from === T + 15 * MIN && r.to === T + 45 * MIN))
      .toBe(true);

    await open(page, logsUrl('{app=~".+"}', T, T + HOUR));
    const alert = card(page, 'Query').getByRole('alert');
    await expect(alert).toContainText('query too broad');
    await expect(alert.getByRole('button', { name: 'Narrow the time range' })).toBeVisible();
  });

  test('e2e:logs-refresh', async ({ page }) => {
    const b = bodies(page);
    await open(page, logsUrl('{app="checkout"}'));
    await expect(rows(page)).toHaveCount(6);
    const first = () => b.range.filter((r) => r.cursor === undefined).length;
    expect(first()).toBe(1);
    await expect.poll(() => b.volume.length).toBe(1);
    await page.getByRole('button', { name: 'Refresh now' }).click();
    await expect.poll(first).toBe(2);
    await expect.poll(() => b.volume.length).toBe(2);
    await expect(rows(page)).toHaveCount(6);
  });

  test('e2e:logs-error-on-run', async ({ page }) => {
    await open(page, logsUrl('{app="x"'));
    await expect(page.locator('.cm-lintRange-error')).not.toHaveCount(0);
    await expect(card(page, 'Query').getByRole('alert')).toContainText("expected '}'");
  });
});

test.describe('e2e:lazy-load logs', () => {
  test('the LogQL editor chunk loads with the Logs page only, once', async ({ page }) => {
    const editorUrls: string[] = [];
    page.on('request', (r) => {
      if (/\/assets\/editor-[^/]+\.js$/.test(new URL(r.url()).pathname)) editorUrls.push(r.url());
    });
    await open(page, '/t/demo/boards');
    await waitReady(page, '/t/demo/boards');
    expect(editorUrls).toEqual([]);
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Logs', exact: true })
      .click();
    await expect(editor(page)).toBeVisible();
    expect(editorUrls.length).toBeGreaterThanOrEqual(1);
    expect(new Set(editorUrls).size).toBe(editorUrls.length);
  });
});
