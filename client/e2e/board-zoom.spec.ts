/**
 * `e2e:board-zoom` (#304 Part B, ADR-0039): a line panel through the range store against the
 * PulsusDB fake's generated wave. Z1 a 3× zoom-out about the centre, once the ladder is held,
 * issues no request at the 3× level's step for the new window and paints rank 1; Z3 a zoom-in
 * paints rank 0 from the held coarser data at once, then rank 1. Chromium only.
 */
import { expect, test, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { HTTP_BFF, NEEDS_BFF, PREVIEW } from './bff.ts';
import { createBoard, deleteBoard } from './boardApi.ts';
import { fakeRequests, type FakeRequest } from './fake.ts';

const HOUR = 3_600_000;
const DAY = 86_400_000;
/** The days of this spec: June 2026, apart from the overscan spec's. */
const BASE = Date.UTC(2026, 5, 2);
const iso = (ms: number): string => new Date(ms).toISOString();

function boardUrl(uid: string, from: number, to: number): string {
  const e = (ms: number) => encodeURIComponent(iso(ms));
  return `/t/demo/board/${uid}?from=${e(from)}&to=${e(to)}&refresh=off`;
}

function day(info: TestInfo, k: number): number {
  return BASE + ((info.repeatEachIndex * 3 + info.retry) * 20 + k) * DAY;
}

const panel = (page: Page) =>
  page
    .locator('[data-panel]')
    .filter({ has: page.getByRole('heading', { level: 3, name: 'Wave', exact: true }) });

async function records(request: APIRequestContext, sinceMs: number): Promise<FakeRequest[]> {
  const all = await fakeRequests(request, { transcript: 'zoom-wave', path: '/api/v1/query_range' });
  return all
    .filter((r) => r.receivedAtMs >= sinceMs)
    .sort((a, b) => a.receivedAtMs - b.receivedAtMs);
}

const meets = (r: FakeRequest, from: number, to: number): boolean =>
  Number(r.start) * 1000 <= to && Number(r.end) * 1000 >= from;

async function go(page: Page, url: string): Promise<void> {
  await page.evaluate((u) => {
    history.pushState(null, '', u);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, url);
}

test.describe('e2e:board-zoom (fake)', () => {
  test.skip(PREVIEW, NEEDS_BFF);
  test.use({ baseURL: HTTP_BFF, viewport: { width: 1440, height: 900 } });
  test.beforeEach(({ browserName }) => {
    test.skip(browserName !== 'chromium', 'chromium only (#304 Part B)');
  });

  test('Z1 zoom out 3×: the ladder paints it with no request', async ({ page, request }, info) => {
    test.setTimeout(90_000);
    const t0 = Date.now();
    const c = day(info, 3) + 12 * HOUR;
    const uid = await createBoard(request, `Z1 ${crypto.randomUUID()}`, [
      { id: 'p-1', title: 'Wave', text: 'zoom_wave', grid: [0, 0, 12, 6], vis: { kind: 'line' } },
    ]);
    try {
      await page.goto(boardUrl(uid, c - 3 * HOUR, c + 3 * HOUR));
      await expect(panel(page)).toHaveAttribute('data-store', 'held');
      // The ladder: 18 h at 60 s and 54 h at 120 s, after the flanks.
      await expect
        .poll(
          async () =>
            (await records(request, t0)).filter((r) => r.step === '120' && r.state === 'completed')
              .length,
          { timeout: 30_000 },
        )
        .toBeGreaterThan(0);
      const before = (await records(request, t0)).length;
      await go(page, boardUrl(uid, c - 9 * HOUR, c + 9 * HOUR));
      await expect(panel(page)).toHaveAttribute('data-rank', '1', { timeout: 2_000 });
      await page.waitForTimeout(800);
      const after = (await records(request, t0)).slice(before);
      for (const r of after) {
        expect(
          r.step === '60' && meets(r, c - 9 * HOUR, c + 9 * HOUR),
          `${r.start}..${r.end}`,
        ).toBe(false);
      }
    } finally {
      await deleteBoard(request, uid);
    }
  });

  test('Z3 zoom in: rank 0 at once, then rank 1', async ({ page, request }, info) => {
    test.setTimeout(90_000);
    const t0 = Date.now();
    const c = day(info, 8) + 12 * HOUR;
    const uid = await createBoard(request, `Z3 ${crypto.randomUUID()}`, [
      { id: 'p-1', title: 'Wave', text: 'zoom_wave', grid: [0, 0, 12, 6], vis: { kind: 'line' } },
    ]);
    try {
      await page.goto(boardUrl(uid, c - 12 * HOUR, c + 12 * HOUR));
      await expect(panel(page)).toHaveAttribute('data-rank', '1', { timeout: 20_000 });
      await expect
        .poll(
          async () => (await records(request, t0)).filter((r) => r.state === 'inflight').length,
          { timeout: 20_000 },
        )
        .toBe(0);
      await page.keyboard.press('Equal');
      await expect(panel(page)).toHaveAttribute('data-rank', '0', { timeout: 2_000 });
      await expect(panel(page)).toHaveAttribute('data-rank', '1', { timeout: 5_000 });
    } finally {
      await deleteBoard(request, uid);
    }
  });
});
