/**
 * View URLs: route plus time Context (02 §4 patterns, time subset; T08-005, IA-023).
 */
import { contextSearchString, readContextSearch, type ContextSearch } from './contextSearch';
import { parseTimeExpr, printTimeExpr, resolveTimeExpr } from './timeExpr';

export type AppRoute =
  | { page: 'boards' | 'exploreMetrics' | 'exploreLogs' | 'admin'; tenant: string }
  | { page: 'board'; tenant: string; uid: string };

export interface ViewUrl {
  route: AppRoute;
  context: ContextSearch;
}

export const TENANT_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const UID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

export function routePath(route: AppRoute): string {
  const base = `/t/${route.tenant}`;
  switch (route.page) {
    case 'boards':
      return `${base}/boards`;
    case 'board':
      return `${base}/board/${route.uid}`;
    case 'exploreMetrics':
      return `${base}/explore/metrics`;
    case 'exploreLogs':
      return `${base}/explore/logs`;
    case 'admin':
      return `${base}/admin`;
  }
}

export function printViewUrl(v: ViewUrl): string {
  return routePath(v.route) + contextSearchString(v.context);
}

function parseRoute(path: string): AppRoute | null {
  const parts = path.split('/');
  // ['', 't', tenant, ...rest]
  if (parts.length < 4 || parts[0] !== '' || parts[1] !== 't') return null;
  const tenant = parts[2] ?? '';
  if (!TENANT_PATTERN.test(tenant)) return null;
  const rest = parts.slice(3).join('/');
  switch (rest) {
    case 'boards':
      return { page: 'boards', tenant };
    case 'explore/metrics':
      return { page: 'exploreMetrics', tenant };
    case 'explore/logs':
      return { page: 'exploreLogs', tenant };
    case 'admin':
      return { page: 'admin', tenant };
  }
  const board = /^board\/([^/]+)$/.exec(rest);
  const uid = board?.[1];
  if (uid !== undefined && UID_PATTERN.test(uid)) return { page: 'board', tenant, uid };
  return null;
}

export function parseViewUrl(pathAndSearch: string, nowMs: number, tz: string): ViewUrl | null {
  const q = pathAndSearch.indexOf('?');
  const path = q === -1 ? pathAndSearch : pathAndSearch.slice(0, q);
  const search = q === -1 ? '' : pathAndSearch.slice(q);
  const route = parseRoute(path);
  if (route === null) return null;
  const { search: context } = readContextSearch(new URLSearchParams(search), {
    nowMs,
    timeZone: tz,
  });
  return { route, context };
}

function pinned(s: string, anchorMs: number, timeZone: string): string {
  const r = parseTimeExpr(s);
  if (!r.ok) throw new RangeError(`invalid time expression: ${s}`);
  return printTimeExpr({ kind: 'absolute', ms: resolveTimeExpr(r.expr, anchorMs, timeZone) });
}

/**
 * The link "Copy link" puts on the clipboard. Unless `keepRelative`, relative expressions are pinned
 * to the instant the view resolves them against (`anchorMs`, the clock anchor), so the link shows
 * the same window as the page (T03-017).
 */
export function buildShareUrl(
  origin: string,
  v: ViewUrl,
  o: { keepRelative: boolean; anchorMs: number; timeZone: string },
): string {
  if (o.keepRelative) return origin + printViewUrl(v);
  const context: ContextSearch = {
    ...v.context,
    from: pinned(v.context.from, o.anchorMs, o.timeZone),
    to: pinned(v.context.to, o.anchorMs, o.timeZone),
  };
  return origin + printViewUrl({ route: v.route, context });
}
