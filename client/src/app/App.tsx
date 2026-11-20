// Stub for the tests-first commit: the implementation follows.
import type { DataRouter } from 'react-router';

import type { RouterDeps } from './router';

export function App({
  deps,
  router,
}: {
  deps: RouterDeps;
  router: DataRouter;
}): import('react').JSX.Element {
  throw new Error('not implemented');
}
