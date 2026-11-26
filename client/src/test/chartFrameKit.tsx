/** Renders chart components inside the app providers and a router, with a fake engine. */
import { render } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { StubApi } from '../api/StubApi';
import { Providers } from '../app/providers';
import type { RouterDeps } from '../app/router';
import { ChartEngineContext } from '../engine/index';
import { createClock } from '../state/clock';
import type { FakeEngine, FakeFrame } from './fakeEngine';
import { T } from './renderApp';

const URL0 = `/t/demo/x?from=2026-11-19T12:00:00.000Z&to=2026-11-19T13:00:00.000Z&refresh=off`;

export function renderChart(engine: FakeEngine, node: ReactNode): { unmount: () => void } {
  const deps: RouterDeps = {
    api: new StubApi(),
    queryClient: new QueryClient(),
    clock: createClock(() => T),
    timeZone: 'Europe/London',
  };
  const router = createMemoryRouter(
    [
      {
        path: '/t/:tenant/x',
        element: <ChartEngineContext.Provider value={engine}>{node}</ChartEngineContext.Provider>,
      },
    ],
    { initialEntries: [URL0] },
  );
  const view = render(
    <Providers deps={deps}>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { unmount: view.unmount };
}

export function lastFrame(engine: FakeEngine): FakeFrame {
  const f = engine.frames.at(-1);
  if (f === undefined) throw new Error('no frame');
  return f;
}
