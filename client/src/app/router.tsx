/**
 * Routes on React Router data mode (ADR-0017): code-based routes, loaders and `lazy`, client only.
 * Loaders gate rendering on the session, reject unknown tenants and `replace()` non-canonical
 * search to its canonical form (IA-022, T08-005), so no extra history entry is added.
 */
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import {
  createBrowserRouter,
  createMemoryRouter,
  data,
  Outlet,
  replace,
  type DataRouter,
  type LoaderFunctionArgs,
  type RouteObject,
} from 'react-router';
import type { Api } from '../api/Api';
import { NotFoundPage, ShellNotFoundPage } from '../pages/NotFoundPage';
import { AppShell } from '../shell/AppShell';
import type { Clock } from '../state/clock';
import { contextSearchString, DEFAULT_CONTEXT, normalisedSearch } from '../state/contextSearch';
import { normalisedExploreSearch } from '../state/exploreParams';
import { normalisedLogsSearch } from '../state/logsParams';
import { RouteErrorPage } from './RouteErrorPage';
import { routeModules } from './routeModules';
import type { RangeStore } from '../data/rangeStore';

/** A board page: its first open sets the time (plan #64 §4.6). */
const BOARD_PATH = /^\/t\/[^/]+\/board\/[^/]+$/;

export interface RouterDeps {
  api: Api;
  queryClient: QueryClient;
  clock: Clock;
  timeZone: string;
  /** The page's range store (#304); absent: the providers make one on `api`. */
  rangeStore?: RangeStore;
}

export type RouterHistory = { kind: 'browser' } | { kind: 'memory'; initialEntries: string[] };

// retry: false: a failed session shows the error page at once with an explicit, keyboard-reachable
// Retry; other queries keep the QueryClient default (retry: 1).
export const sessionQuery = (api: Api) =>
  queryOptions({
    queryKey: ['session'],
    queryFn: ({ signal }) => api.getSession(signal),
    staleTime: Infinity,
    retry: false,
  });

function BootFallback() {
  return <div aria-busy="true" />;
}

export function createRoutes(deps: RouterDeps): RouteObject[] {
  const { api, queryClient, clock, timeZone } = deps;
  const env = () => ({ nowMs: clock.anchor(), timeZone });
  // Cached for the page's lifetime; `removeQueries` (Retry) and `clear()` (Sign out) drop it.
  const session = () => queryClient.query({ ...sessionQuery(api), staleTime: 'static' });

  return [
    {
      id: 'root',
      Component: Outlet,
      HydrateFallback: BootFallback,
      ErrorBoundary: RouteErrorPage,
      children: [
        {
          id: 'index',
          index: true,
          loader: async () => {
            const s = await session();
            throw replace(`/t/${s.defaultTenant}/boards${contextSearchString(DEFAULT_CONTEXT)}`);
          },
        },
        {
          id: 'signedOut',
          path: 'signed-out',
          lazy: () => routeModules.signedOut().then((m) => ({ Component: m.SignedOutPage })),
        },
        {
          id: 'tenant',
          path: 't/:tenant',
          Component: AppShell,
          loader: async ({ request, params }: LoaderFunctionArgs) => {
            const s = await session();
            if (!s.tenants.some((t) => t.slug === params['tenant'])) {
              throw data(null, { status: 404 });
            }
            const url = new URL(request.url);
            // A board link without a time is left to the board, which opens on its saved time
            // (plan #64 §4.6, A.8): normalising here would set the default window first.
            const p = url.searchParams;
            if (BOARD_PATH.test(url.pathname) && !p.has('from') && !p.has('to')) return null;
            const n = normalisedSearch(url.search, env());
            if (n !== null) throw replace(url.pathname + n);
            return null;
          },
          children: [
            {
              id: 'tenantIndex',
              index: true,
              loader: ({ request, params }: LoaderFunctionArgs) => {
                const url = new URL(request.url);
                const search = normalisedSearch(url.search, env()) ?? url.search;
                throw replace(`/t/${params['tenant'] ?? ''}/boards${search}`);
              },
            },
            {
              id: 'boards',
              path: 'boards',
              lazy: () => routeModules.boards().then((m) => ({ Component: m.BoardsPage })),
            },
            {
              id: 'board',
              path: 'board/:uid',
              lazy: () => routeModules.board().then((m) => ({ Component: m.BoardPage })),
            },
            {
              id: 'metrics',
              path: 'explore/metrics',
              // The explore keys `q`, `vis`, `rate` in canonical form (plan #63 §3.5).
              loader: ({ request }: LoaderFunctionArgs) => {
                const url = new URL(request.url);
                const n = normalisedExploreSearch(url.search, env());
                if (n !== null) throw replace(url.pathname + n);
                return null;
              },
              lazy: () => routeModules.metrics().then((m) => ({ Component: m.MetricsPage })),
            },
            {
              id: 'logs',
              path: 'explore/logs',
              // The logs keys `q`, `dir`, `wrap` in canonical form (plan #66 Part C §3.1).
              loader: ({ request }: LoaderFunctionArgs) => {
                const url = new URL(request.url);
                const n = normalisedLogsSearch(url.search, env());
                if (n !== null) throw replace(url.pathname + n);
                return null;
              },
              lazy: () => routeModules.logs().then((m) => ({ Component: m.LogsPage })),
            },
            {
              id: 'admin',
              path: 'admin',
              lazy: () => routeModules.admin().then((m) => ({ Component: m.AdminPage })),
            },
            // The chart and widget galleries and the LogQL editor and log stream harnesses: dev and stub builds only. The condition is inline, so Vite's
            // static replacement lets Rollup drop the branch and its chunk from `http` builds.
            ...(import.meta.env.DEV || import.meta.env.VITE_API_MODE !== 'http'
              ? [
                  {
                    id: 'gallery',
                    path: 'dev/gallery',
                    lazy: () =>
                      import('../dev/GalleryPage').then((m) => ({ Component: m.GalleryPage })),
                  },
                  // The widget gallery of golden:widget-gallery (plan #198 Part 3b §2).
                  {
                    id: 'widgetGallery',
                    path: 'dev/widgets',
                    lazy: () =>
                      import('../dev/WidgetGalleryPage').then((m) => ({
                        Component: m.WidgetGalleryPage,
                      })),
                  },
                  // The geomap gallery of golden:gallery and bench:geomap-markers (plan #234 Part 3).
                  {
                    id: 'geoGallery',
                    path: 'dev/geo',
                    lazy: () =>
                      import('../dev/GeoGalleryPage').then((m) => ({
                        Component: m.GeoGalleryPage,
                      })),
                  },
                  // The LogQL editor harness of the editor benches (plan #66 Part A §3.12).
                  {
                    id: 'logqlBench',
                    path: 'dev/logql-editor',
                    lazy: () =>
                      import('../dev/LogQLEditorBenchPage').then((m) => ({
                        Component: m.LogQLEditorBenchPage,
                      })),
                  },
                  // The log stream harness of e2e:log-stream and bench:log-scroll (plan #66 Part B, B.2).
                  {
                    id: 'logStreamBench',
                    path: 'dev/log-stream',
                    lazy: () =>
                      import('../dev/LogStreamBenchPage').then((m) => ({
                        Component: m.LogStreamBenchPage,
                      })),
                  },
                ]
              : []),
            { id: 'tenantNotFound', path: '*', Component: ShellNotFoundPage },
          ],
        },
        { id: 'notFound', path: '*', Component: NotFoundPage },
      ],
    },
  ];
}

export function createAppRouter(deps: RouterDeps, h: RouterHistory): DataRouter {
  const routes = createRoutes(deps);
  return h.kind === 'browser'
    ? createBrowserRouter(routes)
    : createMemoryRouter(routes, { initialEntries: h.initialEntries });
}
