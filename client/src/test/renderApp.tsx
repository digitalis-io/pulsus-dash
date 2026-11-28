import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { QueryClient } from '@tanstack/react-query';
import { QueryClient as TestQueryClient } from '@tanstack/react-query';
import type { ComponentType, ReactNode } from 'react';
import type { DataRouter } from 'react-router';
import type { Api } from '../api/Api';
import { StubApi } from '../api/StubApi';
import { App } from '../app/App';
import { createAppRouter, type RouterDeps } from '../app/router';
import { createRangeStore } from '../data/rangeStore';
import { createClock, type Clock } from '../state/clock';

/** 2026-11-19 13:03 London (GMT), the fixed "now" of the tests. */
export const T = Date.UTC(2026, 10, 19, 13, 3);

export interface RenderAppOptions {
  api?: Api;
  now?: number | (() => number);
  timeZone?: string;
  queryClient?: QueryClient;
  clock?: Clock;
  /** Wraps the app, e.g. to provide a fake chart engine. */
  wrapper?: ComponentType<{ children: ReactNode }>;
  /**
   * `off`: the range store is switched off, so every panel takes today's single request: the
   * board suites written for it (request shapes, epochs, refresh) test that path. Default `on`.
   */
  rangeStore?: 'on' | 'off';
}

export function renderApp(url: string, o: RenderAppOptions = {}) {
  const api = o.api ?? new StubApi();
  const now = o.now ?? T;
  const clock = o.clock ?? createClock(typeof now === 'function' ? now : () => now);
  const queryClient =
    o.queryClient ??
    new TestQueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
  const deps: RouterDeps = {
    api,
    queryClient,
    clock,
    timeZone: o.timeZone ?? 'Europe/London',
    ...(o.rangeStore === 'off' ? { rangeStore: createRangeStore({ api, enabled: false }) } : {}),
  };
  const router: DataRouter = createAppRouter(deps, { kind: 'memory', initialEntries: [url] });
  const user = userEvent.setup();
  const view = render(
    <App deps={deps} router={router} />,
    o.wrapper === undefined ? undefined : { wrapper: o.wrapper },
  );
  return { router, user, clock, queryClient, api, view };
}

/** `router.state.location` as path + search. */
export function locationOf(router: DataRouter): string {
  return router.state.location.pathname + router.state.location.search;
}
