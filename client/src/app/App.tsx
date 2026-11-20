import type { DataRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { Providers } from './providers';
import type { RouterDeps } from './router';

export function App({ deps, router }: { deps: RouterDeps; router: DataRouter }) {
  return (
    <Providers deps={deps}>
      <RouterProvider router={router} />
    </Providers>
  );
}
