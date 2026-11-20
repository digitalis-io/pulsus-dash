import { describe, expect, it } from 'vitest';
import { T } from '../test/renderApp';
import type { ContextSearch } from './contextSearch';
import { buildShareUrl, parseViewUrl, printViewUrl, type AppRoute, type ViewUrl } from './viewUrl';

const TZ = 'Europe/London';
const ROUTES: AppRoute[] = [
  { page: 'boards', tenant: 'demo' },
  { page: 'board', tenant: 'demo', uid: 'b-1' },
  { page: 'exploreMetrics', tenant: 'demo' },
  { page: 'exploreLogs', tenant: 'demo' },
  { page: 'admin', tenant: 'demo' },
];
const CONTEXTS: ContextSearch[] = [
  { from: 'now-1h', to: 'now', refresh: 'off' },
  { from: 'now-6h', to: 'now', refresh: '30s' },
  { from: '2026-11-19T12:03:00.000Z', to: '2026-11-19T13:03:00.000Z', refresh: '5m' },
  { from: 'now/d', to: 'now', refresh: '15m' },
];

describe('unit:url-codec round-trip', () => {
  it.each(ROUTES.flatMap((route) => CONTEXTS.map((context) => ({ route, context }))))(
    'round-trips $route.page $context.from',
    (v: ViewUrl) => {
      const s = printViewUrl(v);
      expect(parseViewUrl(s, T, TZ)).toEqual(v);
      const parsed = parseViewUrl(s, T, TZ);
      expect(parsed === null ? null : printViewUrl(parsed)).toBe(s);
    },
  );

  it('prints the documented form', () => {
    const board: AppRoute = { page: 'board', tenant: 'demo', uid: 'b-1' };
    expect(
      printViewUrl({ route: board, context: { from: 'now-1h', to: 'now', refresh: 'off' } }),
    ).toBe('/t/demo/board/b-1?from=now-1h&to=now&refresh=off');
  });
});

describe('unit:url-codec copy link', () => {
  const metrics: AppRoute = { page: 'exploreMetrics', tenant: 'demo' };
  const v: ViewUrl = { route: metrics, context: { from: 'now-1h', to: 'now', refresh: 'off' } };
  it('pins relative times to the anchor unless kept relative', () => {
    expect(buildShareUrl('http://x', v, { keepRelative: false, anchorMs: T, timeZone: TZ })).toBe(
      'http://x/t/demo/explore/metrics?from=2026-11-19T12%3A03%3A00.000Z&to=2026-11-19T13%3A03%3A00.000Z&refresh=off',
    );
    expect(
      buildShareUrl('http://x', v, { keepRelative: true, anchorMs: T, timeZone: TZ }),
    ).toContain('from=now-1h&to=now');
  });
  it('leaves an absolute range unchanged', () => {
    const context: ContextSearch = {
      from: '2026-11-19T12:03:00.000Z',
      to: '2026-11-19T13:03:00.000Z',
      refresh: '5m',
    };
    const a: ViewUrl = { route: metrics, context };
    expect(
      buildShareUrl('http://x', a, { keepRelative: false, anchorMs: T + 600_000, timeZone: TZ }),
    ).toBe(`http://x${printViewUrl(a)}`);
  });
});
