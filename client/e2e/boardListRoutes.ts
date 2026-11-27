/**
 * The board list routes for the list e2e gates (plan #216 Part 2a §5; T05): `page.route` answers
 * `GET /me/starred-boards`, `GET /me/recent-boards` and `GET /boards` (the list, not a board) from
 * the test's handlers, and records each request with its time. Other routes reach the BFF.
 */
import type { Page, Route } from '@playwright/test';

export interface ListAnswer {
  readonly status?: number;
  readonly body?: unknown;
  /** Held this long before the answer. */
  readonly delayMs?: number;
}

export type ListSource = 'starred' | 'recent' | 'boards';

export type ListHandler = (url: URL) => ListAnswer;

export interface ListRequest {
  readonly source: ListSource;
  readonly url: URL;
  /** `Date.now()` in the test process when the route saw it. */
  readonly at: number;
}

const SOURCES: readonly (readonly [ListSource, RegExp])[] = [
  ['starred', /\/api\/dash\/v1\/me\/starred-boards$/],
  ['recent', /\/api\/dash\/v1\/me\/recent-boards$/],
  ['boards', /\/api\/dash\/v1\/boards$/],
];

/** Routes the list requests of `page` to `handlers`; a source without one reaches the BFF. */
export async function routeBoardLists(
  page: Page,
  handlers: Partial<Record<ListSource, ListHandler>>,
): Promise<ListRequest[]> {
  const requests: ListRequest[] = [];
  await page.route(
    (url) => SOURCES.some(([, re]) => re.test(url.pathname)),
    async (route: Route) => {
      const req = route.request();
      const url = new URL(req.url());
      const source = SOURCES.find(([, re]) => re.test(url.pathname))?.[0];
      const handler = source === undefined ? undefined : handlers[source];
      if (req.method() !== 'GET' || source === undefined || handler === undefined) {
        await route.fallback();
        return;
      }
      requests.push({ source, url, at: Date.now() });
      const a = handler(url);
      if (a.delayMs !== undefined) await new Promise((r) => setTimeout(r, a.delayMs));
      await route
        .fulfill({
          status: a.status ?? 200,
          contentType: 'application/json',
          body: JSON.stringify(
            a.body ??
              (a.status !== undefined && a.status >= 400
                ? { error: { code: 'x', message: 'x' } }
                : {}),
          ),
        })
        .catch(() => undefined);
    },
  );
  return requests;
}

/** A board list widget panel of the boards API. */
export const listPanelSpec = (
  id: string,
  title: string,
  grid: readonly [number, number, number, number],
  options?: Record<string, unknown>,
) => ({
  id,
  title,
  grid: { x: grid[0], y: grid[1], w: grid[2], h: grid[3] },
  vis: { kind: 'boardList', ...(options === undefined ? {} : { options }) },
});
