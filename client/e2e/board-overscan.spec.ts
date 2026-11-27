/**
 * `e2e:board-overscan` (#304 §5.2): line panels through the range store against the PulsusDB fake's
 * generated waves (§A.4), on the http-mode BFF. O1 a pan of one window issues no request for the
 * revealed window (PRF-028); O2 a cancel storm leaves only the last window's request (PRF-030); O3
 * the board's requests stay within the cap of 6; O4 the auto axis fits the visible window only;
 * O5 a relative refresh hatches only the tail and refetches only its volatile buckets; O6 Refresh
 * now hatches every held span until the refetch lands. Chromium only; each test uses its own days.
 */
import { expect, test, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { HTTP_BFF, NEEDS_BFF, PREVIEW } from './bff.ts';
import { createBoard, deleteBoard, type PanelInput } from './boardApi.ts';
import { fakeRequests, type FakeRequest } from './fake.ts';

const HOUR = 3_600_000;
const DAY = 86_400_000;
/** The days of this spec: March 2026, well before the e2e clock. */
const BASE = Date.UTC(2026, 2, 2);
const iso = (ms: number): string => new Date(ms).toISOString();

function boardUrl(uid: string, from: number, to: number, refresh = 'off'): string {
  const e = (ms: number) => encodeURIComponent(iso(ms));
  return `/t/demo/board/${uid}?from=${e(from)}&to=${e(to)}&refresh=${refresh}`;
}

/** Day `k` of this test: retries and repeats read only their own records. */
function day(info: TestInfo, k: number): number {
  return BASE + ((info.repeatEachIndex * 3 + info.retry) * 40 + k) * DAY;
}

const panel = (page: Page, title: string) =>
  page
    .locator('[data-panel]')
    .filter({ has: page.getByRole('heading', { level: 3, name: title, exact: true }) });

const line = (id: string, title: string, text: string, grid: PanelInput['grid']): PanelInput => ({
  id,
  title,
  text,
  grid,
  vis: { kind: 'line' },
});

/** The fake's records of `transcript` received since `sinceMs`. */
async function records(
  request: APIRequestContext,
  transcript: string,
  sinceMs: number,
): Promise<FakeRequest[]> {
  const all = await fakeRequests(request, { transcript, path: '/api/v1/query_range' });
  return all
    .filter((r) => r.receivedAtMs >= sinceMs)
    .sort((a, b) => a.receivedAtMs - b.receivedAtMs);
}

const span = (r: FakeRequest) => [Number(r.start) * 1000, Number(r.end) * 1000] as const;
const meets = (r: FakeRequest, from: number, to: number): boolean => {
  const [s, e] = span(r);
  return s <= to && e >= from;
};

/** The crosshair slider's range: the window of the frame's last `a11y`. */
async function frameWindow(page: Page, title: string): Promise<[number, number]> {
  const s = panel(page, title).getByRole('slider');
  return [
    Number(await s.getAttribute('aria-valuemin')),
    Number(await s.getAttribute('aria-valuemax')),
  ];
}

async function label(page: Page, title: string): Promise<string> {
  return (await panel(page, title).locator('canvas').first().getAttribute('aria-label')) ?? '';
}

test.describe('e2e:board-overscan (fake)', () => {
  test.skip(PREVIEW, NEEDS_BFF);
  test.use({ baseURL: HTTP_BFF, viewport: { width: 1440, height: 900 } });
  test.beforeEach(({ browserName }) => {
    test.skip(browserName !== 'chromium', 'chromium only (#304 §5.2)');
  });

  test('O1 pan: no request for the revealed window', async ({ page, request }, info) => {
    test.setTimeout(90_000);
    const t0 = Date.now();
    const from = day(info, 0);
    const uid = await createBoard(request, `O1 ${crypto.randomUUID()}`, [
      line('p-1', 'Wave', 'overscan_wave', [0, 0, 12, 6]),
    ]);
    try {
      await page.goto(boardUrl(uid, from, from + HOUR));
      await expect(panel(page, 'Wave')).toHaveAttribute('data-store', 'held');
      // The visible run and one window either side (the ladder runs at its own step).
      await expect
        .poll(
          async () =>
            (await records(request, 'overscan-wave', t0)).filter(
              (r) => r.step === '15' && r.state === 'completed',
            ).length,
          { timeout: 20_000 },
        )
        .toBeGreaterThanOrEqual(3);
      let w = from;
      for (const [key, dir] of [
        [']', 1],
        ['[', -1],
        ['[', -1],
      ] as const) {
        const before = await records(request, 'overscan-wave', t0);
        await page.keyboard.press(key === ']' ? 'BracketRight' : 'BracketLeft');
        w += dir * HOUR;
        await expect.poll(() => frameWindow(page, 'Wave')).toEqual([w, w + HOUR]);
        expect(await label(page, 'Wave')).toMatch(/max 7\.9/);
        await page.waitForTimeout(1_000);
        // The view's step (the Part B ladder runs at its own, coarser step and is not this pan's).
        const after = (await records(request, 'overscan-wave', t0))
          .slice(before.length)
          .filter((r) => r.step === '15');
        for (const r of after) {
          // Only the next flank (or the ladder's), wholly outside the new window.
          expect(meets(r, w, w + HOUR), `${r.start}..${r.end} meets the window`).toBe(false);
        }
        // Background replenishment waits for the next commit.
        await expect
          .poll(
            async () =>
              (await records(request, 'overscan-wave', t0)).filter((r) => r.state === 'inflight')
                .length,
          )
          .toBe(0);
      }
    } finally {
      await deleteBoard(request, uid);
    }
  });

  test('O2 cancel storm: 9 cancelled, the last window painted', async ({ page, request }, info) => {
    test.setTimeout(90_000);
    const t0 = Date.now();
    const w = (i: number) => day(info, 2) + i * DAY;
    const uid = await createBoard(request, `O2 ${crypto.randomUUID()}`, [
      line('p-1', 'Slow', 'overscan_slow', [0, 0, 12, 6]),
    ]);
    try {
      await page.goto(boardUrl(uid, w(0), w(0) + HOUR));
      await expect(panel(page, 'Slow')).toHaveAttribute('data-store', 'held');
      for (let i = 1; i < 10; i++) {
        await page.evaluate(
          (u) => {
            history.pushState(null, '', u);
            window.dispatchEvent(new PopStateEvent('popstate'));
          },
          boardUrl(uid, w(i), w(i) + HOUR),
        );
        await page.waitForTimeout(90);
      }
      await expect
        .poll(() => frameWindow(page, 'Slow'), { timeout: 20_000 })
        .toEqual([w(9), w(9) + HOUR]);
      const rs = await records(request, 'overscan-slow', t0);
      const visibleOf = (i: number) => rs.filter((r) => meets(r, w(i), w(i) + HOUR));
      const cancelled = [...Array(9).keys()].filter((i) =>
        visibleOf(i).every((r) => r.state === 'cancelled'),
      );
      expect(cancelled).toHaveLength(9);
      expect(visibleOf(9).some((r) => r.state === 'completed')).toBe(true);
    } finally {
      await deleteBoard(request, uid);
    }
  });

  test('O3 cap: never more than 6 in flight', async ({ page, request }, info) => {
    test.setTimeout(90_000);
    const t0 = Date.now();
    const from = day(info, 15);
    const panels = Array.from({ length: 12 }, (_, i) =>
      line(`p-${String(i + 1)}`, `Slow ${String(i + 1)}`, `overscan_slow{p="${String(i + 1)}"}`, [
        (i % 4) * 3,
        Math.floor(i / 4) * 4,
        3,
        4,
      ]),
    );
    const uid = await createBoard(request, `O3 ${crypto.randomUUID()}`, panels);
    try {
      await page.goto(boardUrl(uid, from, from + HOUR));
      let max = 0;
      const until = Date.now() + 6_000;
      while (Date.now() < until) {
        const rs = await records(request, 'overscan-slow', t0);
        max = Math.max(max, rs.filter((r) => r.state === 'inflight').length);
        await page.waitForTimeout(100);
      }
      expect(max).toBeGreaterThan(0);
      expect(max).toBeLessThanOrEqual(6);
      const first = (await records(request, 'overscan-slow', t0)).slice(0, 6);
      for (const r of first) expect(meets(r, from, from + HOUR)).toBe(true);
    } finally {
      await deleteBoard(request, uid);
    }
  });

  test('O4 axis fit: a spike in a flank does not move the axis', async ({ page, request }) => {
    test.setTimeout(90_000);
    const t0 = Date.now();
    // The transcript's spike is at 2026-03-01T01:30:00Z, in the right flank of 00:00-01:00.
    const from = Date.UTC(2026, 2, 1);
    const uid = await createBoard(request, `O4 ${crypto.randomUUID()}`, [
      line('p-1', 'Spike', 'overscan_spike', [0, 0, 12, 6]),
    ]);
    try {
      await page.goto(boardUrl(uid, from, from + HOUR));
      await expect
        .poll(
          async () =>
            (await records(request, 'overscan-spike', t0)).filter(
              (r) => r.step === '15' && r.state === 'completed',
            ).length,
          { timeout: 20_000 },
        )
        .toBeGreaterThanOrEqual(3);
      await page.waitForTimeout(500);
      expect(await label(page, 'Spike')).toMatch(/max 6\.9/);
      const axis = await panel(page, 'Spike')
        .locator('[data-chart-frame]')
        .getAttribute('data-value-axis');
      expect(Number(axis?.split(',')[1])).toBeLessThan(1_000);
    } finally {
      await deleteBoard(request, uid);
    }
  });

  test('O5 live: only the tail is hatched and refetched', async ({ page, request }) => {
    test.setTimeout(120_000);
    const t0 = Date.now();
    const uid = await createBoard(request, `O5 ${crypto.randomUUID()}`, [
      line('p-1', 'Live', 'overscan_slow{live="1"}', [0, 0, 12, 6]),
    ]);
    try {
      await page.goto(`/t/demo/board/${uid}?from=now-1h&to=now&refresh=10s`);
      await expect(panel(page, 'Live')).toHaveAttribute('data-store', 'held');
      await expect
        .poll(
          async () =>
            (await records(request, 'overscan-slow', t0)).filter((r) => r.state === 'completed')
              .length,
          { timeout: 30_000 },
        )
        .toBeGreaterThanOrEqual(2);
      const before = (await records(request, 'overscan-slow', t0)).length;
      const stale = panel(page, 'Live').locator('[data-stale-span]');
      await expect(stale).toHaveCount(1, { timeout: 15_000 });
      const box = await stale.boundingBox();
      const plot =
        (await panel(page, 'Live').locator('[data-chart-frame]').getAttribute('data-plot'))
          ?.split(',')
          .map(Number) ?? [];
      const frame = await panel(page, 'Live').locator('[data-chart-frame]').boundingBox();
      // The tail: the span ends at the plot's right edge and does not cover the whole plot.
      expect(
        Math.abs(
          (box?.x ?? 0) + (box?.width ?? 0) - ((frame?.x ?? 0) + (plot[0] ?? 0) + (plot[2] ?? 0)),
        ),
      ).toBeLessThan(2);
      expect(box?.width ?? 0).toBeLessThan((plot[2] ?? 0) - 1);
      const tick = (await records(request, 'overscan-slow', t0)).slice(before);
      const floorS = Date.now() / 1000 - 300 - 256 * 15 - 120;
      for (const r of tick) expect(Number(r.start)).toBeGreaterThanOrEqual(floorS);
      await expect(stale).toHaveCount(0, { timeout: 10_000 });
    } finally {
      await deleteBoard(request, uid);
    }
  });

  test('O6 refresh now: every held span hatched until the refetch lands', async ({
    page,
    request,
  }, info) => {
    test.setTimeout(90_000);
    const t0 = Date.now();
    const from = day(info, 30);
    const uid = await createBoard(request, `O6 ${crypto.randomUUID()}`, [
      line('p-1', 'Again', 'overscan_slow{again="1"}', [0, 0, 12, 6]),
    ]);
    try {
      await page.goto(boardUrl(uid, from, from + HOUR));
      await expect
        .poll(
          async () =>
            (await records(request, 'overscan-slow', t0)).filter((r) => r.state === 'completed')
              .length,
          { timeout: 30_000 },
        )
        .toBeGreaterThanOrEqual(1);
      await expect(panel(page, 'Again').locator('[data-frame-ready="true"]')).toHaveCount(1);
      await page.getByRole('button', { name: 'Refresh now' }).click();
      const stale = panel(page, 'Again').locator('[data-stale-span]');
      await expect(stale.first()).toBeVisible({ timeout: 5_000 });
      await expect(stale).toHaveCount(0, { timeout: 10_000 });
    } finally {
      await deleteBoard(request, uid);
    }
  });
});
