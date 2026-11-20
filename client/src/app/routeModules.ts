/** Route module importers, shared by the router's `lazy` and by preloading on hover and focus. */
export const routeModules = {
  boards: () => import('../pages/boards/BoardsPage'),
  board: () => import('../pages/board/BoardPage'),
  metrics: () => import('../pages/explore/MetricsPage'),
  logs: () => import('../pages/explore/LogsPage'),
  admin: () => import('../pages/admin/AdminPage'),
  signedOut: () => import('../pages/SignedOutPage'),
} as const;

export type RouteModuleId = keyof typeof routeModules;

/** Starts loading a route module. Rejection is swallowed here; the route's `lazy` surfaces it. */
export function preloadRoute(id: RouteModuleId): void {
  routeModules[id]().catch(() => undefined);
}
