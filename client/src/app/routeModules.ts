// Stub for the tests-first commit: the implementation follows.
/** Stub (tests-first commit): any use throws. */
function notImplemented<T>(): T {
  const fail = (): never => {
    throw new Error('not implemented');
  };
  return new Proxy(fail, { get: fail, apply: fail, construct: fail, ownKeys: fail }) as T;
}

export const routeModules: {
  readonly boards: () => Promise<typeof import('../pages/boards/BoardsPage')>;
  readonly board: () => Promise<typeof import('../pages/board/BoardPage')>;
  readonly metrics: () => Promise<typeof import('../pages/explore/MetricsPage')>;
  readonly logs: () => Promise<typeof import('../pages/explore/LogsPage')>;
  readonly admin: () => Promise<typeof import('../pages/admin/AdminPage')>;
  readonly signedOut: () => Promise<typeof import('../pages/SignedOutPage')>;
} = notImplemented();

export type RouteModuleId = keyof typeof routeModules;

export function preloadRoute(id: RouteModuleId): void {
  throw new Error('not implemented');
}
