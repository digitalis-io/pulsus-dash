/**
 * `e2e:board-prefs` (plan #61 Part C §5.3, Appendix C-A §A.4): Starred and Recent are stored per
 * user by the BFF, so a fresh browser context of the same user sees them; another tab of the same
 * profile hears a change at once, another context when its tab is shown again.
 */
import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { HTTP_BFF, NEEDS_BFF, PREVIEW } from './bff.ts';

const API = '/api/dash/v1';
const POLL = { timeout: 5_000 };

/** The link texts of a sidebar group: the element right after its heading. */
function group(page: Page, name: 'Starred' | 'Recent'): Promise<string[]> {
  return page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('heading', { name, exact: true })
    .locator('xpath=following-sibling::*[1]')
    .locator('a')
    .allTextContents()
    .then((all) => all.map((s) => s.replace('★', '').trim()));
}

const starred = (page: Page) => group(page, 'Starred');
const recent = (page: Page) => group(page, 'Recent');

/** What TanStack's focus manager hears when a tab is shown again. */
async function visible(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
  });
}

async function fresh(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({
    baseURL: HTTP_BFF,
    locale: 'en-GB',
    timezoneId: 'Europe/London',
    viewport: { width: 1440, height: 900 },
  });
}

/** Console errors and page errors; `allow` matches messages that are expected. */
function errorsOf(page: Page, allow: RegExp): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !allow.test(m.text())) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

async function remove(request: APIRequestContext, uid: string): Promise<void> {
  const r = await request.get(`${API}/boards/${uid}`);
  if (r.status() === 404) return;
  const { etag } = (await r.json()) as { etag: string };
  const d = await request.delete(`${API}/boards/${uid}`, { headers: { 'If-Match': `"${etag}"` } });
  expect([204, 404]).toContain(d.status());
}

async function refUids(request: APIRequestContext, path: string): Promise<string[]> {
  const r = await request.get(path);
  expect(r.status()).toBe(200);
  return ((await r.json()) as { items: { uid: string }[] }).items.map((x) => x.uid);
}

async function ready(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.locator('html[data-shell-ready="true"]').waitFor();
}

test.describe('e2e:board-prefs', () => {
  test.skip(PREVIEW, NEEDS_BFF);
  test.use({ baseURL: HTTP_BFF });

  test('starred and recent follow the user', async ({ browser, request }, testInfo) => {
    test.setTimeout(120_000);
    const title = `E2E prefs ${testInfo.project.name} w${String(testInfo.workerIndex)} ${crypto.randomUUID()}`;
    let uid: string | null = null;
    const contexts: BrowserContext[] = [];
    const errors: string[] = [];
    try {
      // 1. Create.
      const created = await request.post(`${API}/boards`, {
        data: { spec: { title, panels: [], sections: [] } },
      });
      expect(created.status()).toBe(201);
      uid = ((await created.json()) as { uid: string }).uid;
      const boardUrl = `/t/demo/board/${uid}`;

      // 2. Open it in context A.
      const a = await fresh(browser);
      contexts.push(a);
      const a1 = await a.newPage();
      errors.push(...errorsOf(a1, /status of 503/));
      await ready(a1, boardUrl);
      await expect.poll(() => recent(a1), POLL).toContain(title);
      expect(await refUids(request, `${API}/me/recent-boards?limit=50`)).toContain(uid);

      // 3. A second tab of A.
      const a2 = await a.newPage();
      errors.push(...errorsOf(a2, /status of 503/));
      await ready(a2, '/t/demo/boards');
      await expect.poll(() => starred(a2), POLL).not.toContain(title);

      // 4. Star in A1: A2 hears it on the channel, with no reload and no visibility change.
      const starA1 = a1.getByRole('button', { name: 'Star board' });
      await starA1.click();
      await expect(starA1).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(() => starred(a1), POLL).toContain(title);
      await expect.poll(() => starred(a2), POLL).toContain(title);
      expect(await refUids(request, `${API}/me/starred-boards`)).toContain(uid);

      // 5. A fresh context B (empty storage) lists the board in both groups before any click.
      const b = await fresh(browser);
      contexts.push(b);
      const b1 = await b.newPage();
      errors.push(...errorsOf(b1, /status of 503/));
      await ready(b1, '/t/demo/boards');
      await expect.poll(() => starred(b1), POLL).toContain(title);
      await expect.poll(() => recent(b1), POLL).toContain(title);
      const localKeys = await b1.evaluate(() => Object.keys(localStorage));
      expect(localKeys.filter((k) => k.startsWith('pulsus-dash.recent.'))).toEqual([]);

      // 6. Open it from B's Starred and unstar it.
      await b1
        .getByRole('navigation', { name: 'Main' })
        .getByRole('heading', { name: 'Starred', exact: true })
        .locator('xpath=following-sibling::*[1]')
        .getByRole('link', { name: title })
        .click();
      await expect(b1).toHaveURL((u) => u.pathname === boardUrl);
      const starB1 = b1.getByRole('button', { name: 'Star board' });
      await expect(starB1).toHaveAttribute('aria-pressed', 'true');
      await starB1.click();
      await expect(starB1).toHaveAttribute('aria-pressed', 'false');
      await expect.poll(() => starred(b1), POLL).not.toContain(title);

      // 7. A1 is shown again: both lists refetch, with no reload.
      await visible(a1);
      await expect.poll(() => starred(a1), POLL).not.toContain(title);
      await expect(starA1).toHaveAttribute('aria-pressed', 'false');

      // 8. A failed star shows a visible message.
      await a1.route('**/api/dash/v1/me/starred-boards/*', (r) => r.fulfill({ status: 503 }));
      await starA1.click();
      await expect(starA1).toHaveAttribute('aria-pressed', 'false');
      const message = a1.getByText('Could not update Starred. Try again.');
      await expect(message).toBeVisible();
      const box = await message.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(100);
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(12);
      await a1.unroute('**/api/dash/v1/me/starred-boards/*');
      expect(errors).toEqual([]);
    } finally {
      if (uid !== null) await remove(request, uid);
      for (const c of contexts) await c.close();
    }
  });
});
