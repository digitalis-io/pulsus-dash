/**
 * `e2e:log-stream` (plan #66 Part B, B.4; PRF-020, VIZ-034): the log stream on the dev-only
 * harness over the synthetic log API. The top row keeps its ordinal and offset across far-end
 * eviction and re-slicing (fixed and wrapped rows, wheel in every browser, touch in Chromium);
 * the last of 10⁶ held rows is reachable; a wrapped slice stays within its pixel bound with rows
 * of at most 2 000 px; rows taller than estimated are re-sliced back within the bound; wrapping
 * keeps the top row.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  MAX_ENTRIES,
  atRest,
  expectSameTop,
  openBench,
  reslicesLog,
  rowBoxes,
  scrollToOrd,
  sliceStart,
  state,
  topRow,
  wheel,
  type BenchConfig,
} from './logStreamBench.ts';

const E2_VIEW = { cap: 2_000, margin: 200, maxPx: 8_000_000, hardPx: 12_000_000 };
const E7_VIEW = { cap: 2_000, margin: 200, maxPx: 40_000, hardPx: 1_000_000_000 };
const E7_CONFIG: BenchConfig = {
  total: 3_000,
  prefillTo: 3_000,
  capEntries: MAX_ENTRIES,
  latencyMs: 0,
  wrap: true,
  lineLength: 40_000,
  wrapEstimate: 'row',
  view: E7_VIEW,
};

/** Wheels down until the top row is in the last page of the prefilled buffer (the list's end
 *  before the wheel): the tail prefetch then extends the list and evicts head pages. A row, not a
 *  pixel target, since wrapped rows are estimated taller than they measure. */
async function wheelToNearEnd(page: Page, prefill: number): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    const top = await topRow(page);
    if (top !== null && top.ord >= prefill - 50) return;
    await wheel(page, 1_000);
  }
}

/** E2 and E6: the top row is kept at every re-slice decided since `from` records. */
async function expectKeptSince(page: Page, from: number, what: string): Promise<number> {
  const log = await reslicesLog(page);
  const now = await topRow(page);
  for (const r of log.slice(from)) {
    if (r.cause === 'edge' || r.cause === 'extent' || r.cause === 'hard') {
      expectSameTop(r.before, now, `${what}: ${r.cause} re-slice`);
    }
  }
  return log.length;
}

/** The E7 precondition: every mounted row's line wraps past 100 lines. */
async function expectWrapsPast100(page: Page): Promise<void> {
  const { rows } = await rowBoxes(page);
  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows) {
    expect(r.lines, `row ${String(r.ord)} wraps to ${r.lines.toFixed(1)} lines`).toBeGreaterThan(
      100,
    );
  }
}

test.describe('e2e:log-stream', () => {
  test.describe.configure({ timeout: 300_000 });

  for (const wrap of [false, true]) {
    test(`E1 eviction keeps the top row (${wrap ? 'wrapped' : 'fixed'} rows)`, async ({ page }) => {
      // Cap 6 000, not 3 000: with 1 000-row pages and the 2 000-row prefetch, the prefetch stops
      // 2 000–3 000 rows past the view, so a 6 000-row buffer always leaves two head pages outside
      // the shown rows to evict (a 3 000-row buffer leaves none).
      await openBench(page, {
        total: 50_000,
        prefillTo: 6_000,
        capEntries: 6_000,
        latencyMs: 0,
        wrap,
        ...(wrap ? { lineLength: 300 } : {}),
      });
      await wheelToNearEnd(page, 6_000);
      await atRest(page);
      const first = (await state(page)).firstOrd;
      const kept = await topRow(page);
      let evictions = 0;
      for (let i = 0; i < 20 && evictions < 2; i += 1) {
        const before = (await state(page)).firstOrd;
        await page.evaluate(() => window.__logStreamBench?.loadTail());
        // The eviction's re-slice runs at rest after the page lands; its write is a scroll event.
        await page.waitForTimeout(500);
        await atRest(page);
        const s = await state(page);
        if (s.firstOrd > before) {
          evictions = Math.floor((s.firstOrd - first) / 1_000);
          expectSameTop(kept, await topRow(page), `after eviction to ${String(s.firstOrd)}`);
        }
      }
      expect((await state(page)).firstOrd - first).toBeGreaterThanOrEqual(2_000);
      expectSameTop(kept, await topRow(page), 'at the end');
    });

    test(`E2 re-slicing keeps the top row (${wrap ? 'wrapped' : 'fixed'} rows)`, async ({
      page,
    }) => {
      await openBench(page, {
        total: 50_000,
        prefillTo: 20_000,
        capEntries: MAX_ENTRIES,
        latencyMs: 0,
        view: E2_VIEW,
        wrap,
        ...(wrap ? { lineLength: 300 } : {}),
      });
      await scrollToOrd(page, 1_000);
      await atRest(page);
      let changes = 0;
      let seen = (await reslicesLog(page)).length;
      let start = await sliceStart(page);
      for (let i = 0; i < 600 && changes < 3; i += 1) {
        await wheel(page, 400);
        await atRest(page);
        const now = await sliceStart(page);
        if (now !== start) {
          changes += 1;
          seen = await expectKeptSince(page, seen, `change ${String(changes)}`);
          start = now;
        }
      }
      expect(changes).toBe(3);
    });
  }

  test('E3 the last of 10⁶ rows is reachable', async ({ page }) => {
    test.setTimeout(300_000);
    await openBench(
      page,
      // A run of exactly 10⁶ entries: Firefox and WebKit animate End, and with more entries the
      // tail prefetch would extend the list under the animation, past row 10⁶.
      { total: 1_000_000, prefillTo: 1_000_000, capEntries: MAX_ENTRIES, latencyMs: 0 },
      240_000,
    );
    await scrollToOrd(page, 999_990);
    await atRest(page);
    await page.locator('[data-log-scroller]').press('End');
    await atRest(page);
    const rects = await page.evaluate(() => {
      const r = document.querySelector('[aria-posinset="1000000"]')?.getBoundingClientRect();
      const b = document.querySelector('[data-log-scroller]')?.getBoundingClientRect();
      return r === undefined || b === undefined
        ? null
        : { top: r.top, bottom: r.bottom, boxTop: b.top, boxBottom: b.bottom };
    });
    expect(rects, 'row 1 000 000 is mounted').not.toBeNull();
    expect(rects?.top ?? 0).toBeGreaterThanOrEqual((rects?.boxTop ?? 0) - 1);
    expect(rects?.bottom ?? 0).toBeLessThanOrEqual((rects?.boxBottom ?? 0) + 1);
  });

  test('E4 wrap keeps the top row', async ({ page }) => {
    await openBench(page, {
      total: 5_000,
      prefillTo: 5_000,
      capEntries: MAX_ENTRIES,
      latencyMs: 0,
      lineLength: 400,
    });
    await scrollToOrd(page, 2_500);
    await atRest(page);
    expect((await topRow(page))?.ord).toBe(2_500);
    // The checkbox's input is visually hidden: press its label.
    await page.getByText('Wrap lines', { exact: true }).click();
    await expect(page.getByRole('checkbox', { name: 'Wrap lines' })).toBeChecked();
    await atRest(page);
    expect((await topRow(page))?.ord).toBe(2_500);
    const row = page.locator('[data-log-row][data-ord="2500"]');
    expect(await row.locator('[data-log-line]').evaluate((e) => e.textContent.length)).toBe(400);
    const h = (await row.boundingBox())?.height ?? 0;
    expect(h).toBeGreaterThanOrEqual(40);
    expect(h).toBeLessThanOrEqual(2_000);
  });

  test('E5 the wrapped extent is bounded and still at rest', async ({ page }) => {
    await openBench(
      page,
      {
        total: 30_000,
        prefillTo: 30_000,
        capEntries: MAX_ENTRIES,
        latencyMs: 0,
        wrap: true,
        lineLength: 20_000,
      },
      240_000,
    );
    await scrollToOrd(page, 29_999);
    await atRest(page);
    const { listHeight, rows } = await rowBoxes(page);
    expect(listHeight).toBeLessThanOrEqual(8_000_000);
    for (const r of rows) expect(r.height, `row ${String(r.ord)}`).toBeLessThanOrEqual(2_000);
    const rects = await page.evaluate(() => {
      const r = document.querySelector('[aria-posinset="30000"]')?.getBoundingClientRect();
      const b = document.querySelector('[data-log-scroller]')?.getBoundingClientRect();
      return r === undefined || b === undefined
        ? null
        : { top: r.top, bottom: r.bottom, boxTop: b.top, boxBottom: b.bottom };
    });
    expect(rects, 'row 30 000 is mounted').not.toBeNull();
    expect(rects?.bottom ?? 0).toBeGreaterThan(rects?.boxTop ?? 0);
    expect(rects?.top ?? 0).toBeLessThan(rects?.boxBottom ?? 0);
    const start = await sliceStart(page);
    const writes = (await state(page)).writes;
    await page.waitForTimeout(2_000);
    expect(await sliceStart(page)).toBe(start);
    expect((await state(page)).writes).toBe(writes);
  });

  test('E7a rows taller than estimated are re-sliced at rest', async ({ page }) => {
    await page.setViewportSize({ width: 1_440, height: 900 });
    await openBench(page, E7_CONFIG);
    await scrollToOrd(page, 1_000);
    await atRest(page);
    await expectWrapsPast100(page);
    expect((await state(page)).reslices.extent).toBeGreaterThanOrEqual(1);
    let seen = 0;
    for (let step = 0; step <= 5; step += 1) {
      if (step > 0) {
        await wheel(page, 600);
        await atRest(page);
      }
      const { listHeight, rows } = await rowBoxes(page);
      expect(listHeight, `step ${String(step)}: list height`).toBeLessThanOrEqual(40_000);
      for (const r of rows) {
        expect(r.height, `row ${String(r.ord)}`).toBeLessThanOrEqual(2_000);
        expect(r.scrollHeight, `row ${String(r.ord)} scrolls inside`).toBeGreaterThan(
          r.clientHeight,
        );
      }
      const log = await reslicesLog(page);
      const now = await topRow(page);
      for (const r of log.slice(seen)) {
        if (r.cause === 'extent' && step > 0) expectSameTop(r.before, now, `step ${String(step)}`);
      }
      seen = log.length;
    }
  });

  test('E7b rows taller than estimated are re-sliced while scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 1_440, height: 900 });
    await openBench(page, { ...E7_CONFIG, view: { ...E7_VIEW, hardPx: 60_000 } });
    await scrollToOrd(page, 1_000);
    await atRest(page);
    await expectWrapsPast100(page);
    // Every frame's list height while the wheel events run.
    await page.evaluate(() => {
      const w = window as unknown as { __heights: number[]; __sampling: boolean };
      w.__heights = [];
      w.__sampling = true;
      const tick = () => {
        const list = document.querySelector<HTMLElement>('[data-slice-start]');
        w.__heights.push(list?.getBoundingClientRect().height ?? 0);
        if (w.__sampling) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    for (let i = 0; i < 80; i += 1) {
      await wheel(page, 2_000);
      await page.waitForTimeout(50);
    }
    const heights = await page.evaluate(() => {
      const w = window as unknown as { __heights: number[]; __sampling: boolean };
      w.__sampling = false;
      return w.__heights;
    });
    expect((await state(page)).reslicesScrolling.hard).toBeGreaterThanOrEqual(1);
    await expectWrapsPast100(page);
    expect(Math.max(...heights)).toBeLessThanOrEqual(60_000 + 120_000);
  });

  test('E6 touch: no scroll write during the gesture', async ({ browser, browserName }) => {
    test.skip(browserName !== 'chromium', 'CDP touch gestures are Chromium only');
    const context = await browser.newContext({ hasTouch: true });
    const page = await context.newPage();
    try {
      await openBench(page, {
        total: 50_000,
        prefillTo: 20_000,
        capEntries: MAX_ENTRIES,
        latencyMs: 0,
        view: E2_VIEW,
      });
      await scrollToOrd(page, 1_000);
      await atRest(page);
      const cdp = await context.newCDPSession(page);
      const box = await page.locator('[data-log-scroller]').boundingBox();
      if (box === null) throw new Error('no box');
      let changes = 0;
      let seen = (await reslicesLog(page)).length;
      let start = await sliceStart(page);
      for (let i = 0; i < 40 && changes < 2; i += 1) {
        const writes = (await state(page)).writes;
        // A touch drag of 3 000 px at about 3 000 px/s, from CDP touch events: headless
        // Chromium's synthesizeScrollGesture with a touch source does not scroll.
        const x = box.x + box.width / 2;
        const y0 = box.y + box.height - 20;
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [{ x, y: y0 }],
        });
        for (let step = 1; step <= 60; step += 1) {
          await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [{ x, y: y0 - ((step % 12) + 1) * 50 }],
          });
          if (step % 12 === 11) {
            // Lift and put the finger down again: the scroller is shorter than 3 000 px.
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            expect((await state(page)).writes, 'no scrollTop write during the gesture').toBe(
              writes,
            );
            await cdp.send('Input.dispatchTouchEvent', {
              type: 'touchStart',
              touchPoints: [{ x, y: y0 }],
            });
          }
          await page.waitForTimeout(16);
        }
        expect((await state(page)).writes, 'no scrollTop write during the gesture').toBe(writes);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await atRest(page);
        const now = await sliceStart(page);
        if (now !== start) {
          changes += 1;
          seen = await expectKeptSince(page, seen, `touch change ${String(changes)}`);
          start = now;
        }
      }
      expect(changes).toBe(2);
    } finally {
      await context.close();
    }
  });
});
