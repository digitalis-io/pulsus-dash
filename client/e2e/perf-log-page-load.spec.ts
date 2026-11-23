/**
 * `bench:log-page-load` (plan #66 Part C §5.4; PRF-005, PRF-020; Chromium only, http BFF and the
 * PulsusDB fake): the main-thread cost of Explore › Logs loading and decoding a 1 000-entry page
 * over HTTP, then rendering a second page.
 *
 * The page opens on `{app="checkout"}`; the editor text becomes `{app="paging"}` (outside the
 * trace). Window one runs from `bench:start` (before Run) to `bench:page1` (the first `paging
 * line 0000` row mounted); window two from there to `bench:end` (the list scrolled to its end,
 * then 1 s). `LogStream` prefetches the next page as soon as page one renders, so the **cursor
 * gate** (a `page.route` on the range route's path, which also matches the tenant-scoped
 * `/range?tenant=…` request) holds every request with a `cursor` until `bench:page1` is marked:
 * page two's answer and decode always fall in window two.
 *
 * Always: the request and attribution checks below and T05 §4.3's interim CI check (`ciOver`).
 * `LOG_BENCH_GATE=enforce` (the reference lab and the local D13 proofs) also fails on any
 * main-thread task over 16 ms in either window; otherwise each breach is a `warning` annotation.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { longTasks, type TraceEvent } from '../scripts/longTasks.ts';
import { HTTP_BFF, NEEDS_BFF, PREVIEW } from './bff.ts';
import { waitReady } from './helpers.ts';

const enforce = process.env['LOG_BENCH_GATE'] === 'enforce';
const L0 = Date.UTC(2026, 0, 1, 12);
const HOUR = 3_600_000;
const RANGE = '/api/dash/v1/query/logql/range';
const LOGQL = '/api/dash/v1/query/logql/';
const CATEGORIES = [
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'blink.user_timing',
];

const iso = (ms: number) => encodeURIComponent(new Date(ms).toISOString());
const URL_CHECKOUT = `/t/demo/explore/logs?from=${iso(L0)}&to=${iso(L0 + HOUR)}&refresh=off&q=${encodeURIComponent('{app="checkout"}')}`;

declare global {
  interface Window {
    __page2AtMark?: boolean;
  }
}

interface Seen {
  readonly path: string;
  readonly body: { query?: string; cursor?: string } | null;
}

test.describe('bench:log-page-load', () => {
  test.skip(PREVIEW, NEEDS_BFF);
  test.use({ baseURL: HTTP_BFF });

  test('bench:log-page-load (checks always; lab threshold with LOG_BENCH_GATE=enforce)', async ({
    page,
    browserName,
  }, info) => {
    test.skip(browserName !== 'chromium', 'a Chromium trace');
    test.setTimeout(180_000);

    // 1 The cursor gate, registered before the page opens.
    let release!: () => void;
    const page1Marked = new Promise<void>((r) => {
      release = r;
    });
    let cursorHeld = 0;
    await page.route(
      (u) => u.pathname === RANGE,
      async (route) => {
        const body = route.request().postDataJSON() as { cursor?: string } | null;
        if (body?.cursor === undefined) return route.continue();
        cursorHeld += 1;
        await page1Marked; // resolved in step 5, after bench:page1 exists in the page
        return route.continue(); // the BFF and the fake answer it (logs-paging-2)
      },
    );
    let counting = false;
    const seen: Seen[] = [];
    page.on('request', (r) => {
      const path = new URL(r.url()).pathname;
      if (!counting || !path.startsWith(LOGQL)) return;
      seen.push({ path, body: r.postDataJSON() as Seen['body'] });
    });

    await page.goto(URL_CHECKOUT);
    await waitReady(page, URL_CHECKOUT);
    const list = page.getByRole('list', { name: 'Log lines' });
    await expect(list.locator('[data-log-row]')).toHaveCount(6);
    await expect(list).toContainText('checkout line F');

    // 2 The new text, not run.
    const editor = page.getByRole('textbox', { name: 'LogQL query' });
    await editor.click();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.press('Backspace');
    await page.keyboard.insertText('{app="paging"}');
    await expect(editor).toHaveText('{app="paging"}');
    const run = page.getByRole('button', { name: 'Run' });

    // 3 Window one opens.
    const browser = page.context().browser();
    if (browser === null) throw new Error('no browser to trace');
    await browser.startTracing(page, { categories: CATEGORIES });
    counting = true;
    await page.evaluate(() => performance.mark('bench:start'));

    // 4 Run; the response wait is registered before the click, so a fast reply is not missed.
    const r = page.waitForResponse((resp) => {
      if (new URL(resp.url()).pathname !== RANGE) return false;
      const b = resp.request().postDataJSON() as { query?: string; cursor?: string } | null;
      return b?.query === '{app="paging"}' && b.cursor === undefined;
    });
    await Promise.all([run.click(), r]);

    // 5 Page one rendered: the mark and the page-two check in the same frame, then the gate opens.
    await page.waitForFunction(
      () => {
        const row = document.querySelector('[data-log-row][data-ord="0"]');
        if (row?.textContent.endsWith('paging line 0000') !== true) return false;
        performance.mark('bench:page1');
        window.__page2AtMark = [...document.querySelectorAll('[data-ord]')].some(
          (e) => Number(e.getAttribute('data-ord')) >= 1000,
        );
        return true;
      },
      undefined,
      { polling: 'raf', timeout: 30_000 },
    );
    release();

    // 6 Window two: to the end of the list, then 1 s.
    const region = page.locator('[data-log-scroller]');
    await region.scrollIntoViewIfNeeded();
    const box = await region.boundingBox();
    if (box === null) throw new Error('no Log lines region');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const end = page.getByText('End of results');
    for (let i = 0; i < 400 && !(await end.isVisible()); i++) {
      await page.mouse.wheel(0, 2_000);
      await page.waitForTimeout(20);
    }
    await expect(end).toBeVisible();
    await page.waitForTimeout(1_000);
    const lastRow = await page.evaluate(
      () => document.querySelector('[data-log-row][data-ord="1499"]')?.textContent ?? null,
    );
    await page.evaluate(() => performance.mark('bench:end'));
    counting = false;

    // 7 The trace, split at bench:page1.
    const events = (
      JSON.parse(String(await browser.stopTracing())) as { traceEvents: TraceEvent[] }
    ).traceEvents;
    const inputs = ['click', 'wheel'];
    const w1 = longTasks(events, { inputs, marks: { start: 'bench:start', end: 'bench:page1' } });
    const w2 = longTasks(events, { inputs, marks: { start: 'bench:page1', end: 'bench:end' } });
    const t = await page.evaluate(() => {
      const mark = (n: string) => performance.getEntriesByName(n)[0]?.startTime ?? NaN;
      const start = mark('bench:start');
      const ranges = performance
        .getEntriesByType('resource')
        .filter((e) => new URL(e.name).pathname === '/api/dash/v1/query/logql/range')
        .filter((e) => e.startTime > start)
        .map((e) => (e as PerformanceResourceTiming).responseEnd);
      return {
        start,
        page1: mark('bench:page1'),
        end: mark('bench:end'),
        ranges,
        page2AtMark: window.__page2AtMark,
      };
    });
    const round = (x: number) => Math.round(x * 10) / 10;
    const report = {
      page1Ms: round(t.page1 - t.start),
      endMs: round(t.end - t.start),
      tasks: [w1.tasks, w2.tasks].map((ts) => ts.map((x) => [x.tsUs, round(x.durMs)])),
      worst: [round(w1.worstMs), round(w2.worstMs)],
      ciOver: w1.ciOver + w2.ciOver,
      cursorHeld,
      mode: enforce ? 'enforce' : 'ci',
    };
    mkdirSync('test-results', { recursive: true });
    writeFileSync('test-results/bench-log-page-load.json', `${JSON.stringify(report, null, 2)}\n`);
    info.annotations.push({
      type: 'bench:log-page-load',
      description: `page one ${String(report.page1Ms)} ms, end ${String(report.endMs)} ms; worst task ${String(report.worst[0])} ms / ${String(report.worst[1])} ms; cursor gate held ${String(cursorHeld)}`,
    });

    // Always.
    const ranges = seen.filter((s) => s.path === RANGE);
    expect(ranges.map((s) => s.body?.query)).toEqual(['{app="paging"}', '{app="paging"}']);
    expect(ranges[0]?.body?.cursor).toBeUndefined();
    expect(ranges[1]?.body?.cursor).toEqual(expect.any(String));
    expect(cursorHeld, 'the gate held the tenant-scoped cursor request').toBe(1);
    const volumes = seen.filter((s) => s.path === '/api/dash/v1/query/logql/volume');
    expect(volumes.map((s) => s.body?.query)).toEqual(['{app="paging"}']);
    expect(seen.length, 'no other /query/logql/ request').toBe(3);
    expect(t.ranges, 'two range responses in the windows').toHaveLength(2);
    const [first = NaN, second = NaN] = t.ranges;
    expect(first, 'page one answered after bench:start').toBeGreaterThan(t.start);
    expect(first, 'page one answered by bench:page1').toBeLessThanOrEqual(t.page1);
    expect(second, 'page two answered after bench:page1').toBeGreaterThan(t.page1);
    expect(t.page2AtMark, 'no page-two row at bench:page1').toBe(false);
    expect(lastRow ?? '', 'page two rendered in window two').toMatch(/paging line 1499$/);
    expect(report.ciOver, 'ciOver').toBe(0);

    const breaches = [
      ...(w1.over16 > 0 ? [`window one: ${String(w1.over16)} tasks over 16 ms (PRF-005)`] : []),
      ...(w2.over16 > 0 ? [`window two: ${String(w2.over16)} tasks over 16 ms (PRF-005)`] : []),
    ];
    if (enforce) expect(breaches).toEqual([]);
    else for (const b of breaches) info.annotations.push({ type: 'warning', description: b });
  });
});
