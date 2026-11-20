// Stub for the tests-first commit: the implementation follows.
/**
 * Routes on React Router data mode (ADR-0017): code-based routes, loaders and `lazy`, client only.
 * Loaders gate rendering on the session, reject unknown tenants and `replace()` non-canonical
 * search to its canonical form (IA-022, T08-005), so no extra history entry is added.
 */
import { type QueryClient } from '@tanstack/react-query';

import { type DataRouter, type RouteObject } from 'react-router';

import type { Api } from '../api/Api';

import type { Clock } from '../state/clock';

/** Stub (tests-first commit): any use throws. */
function notImplemented<T>(): T {
  const fail = (): never => {
    throw new Error('not implemented');
  };
  return new Proxy(fail, { get: fail, apply: fail, construct: fail, ownKeys: fail }) as T;
}

export interface RouterDeps {
  api: Api;
  queryClient: QueryClient;
  clock: Clock;
  timeZone: string;
}

export type RouterHistory =
  | {
      kind: 'browser';
    }
  | {
      kind: 'memory';
      initialEntries: string[];
    };

export const sessionQuery: (api: Api) => import('@tanstack/query-core').OmitKeyof<
  import('@tanstack/react-query').UseQueryOptions<
    import('../api').Session,
    Error,
    import('../api').Session,
    string[]
  >,
  'queryFn'
> & {
  queryFn?: import('@tanstack/query-core').QueryFunction<import('../api').Session, string[], never>;
} & import('@tanstack/query-core').QueryKeyWithDataTag<string[], import('../api').Session, Error> =
  notImplemented();

export function createRoutes(deps: RouterDeps): RouteObject[] {
  throw new Error('not implemented');
}

export function createAppRouter(deps: RouterDeps, h: RouterHistory): DataRouter {
  throw new Error('not implemented');
}
