/**
 * Renders a component under a memory router, a query client, a clock and the London zone, for the
 * unit tests of hooks that read the time Context (plan #64 §5.1 `epoch mark`, `refreshNow` rule).
 */
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { createClock, type Clock } from '../state/clock';
import { TimeZoneContext } from '../state/timeZone';
import { ClockContext } from '../state/useTimeContext';
import { T } from './renderApp';

export function renderRouted(
  element: ReactNode,
  o: { url: string; queryClient?: QueryClient; clock?: Clock },
) {
  const queryClient = o.queryClient ?? new QueryClient();
  const clock = o.clock ?? createClock(() => T);
  const router = createMemoryRouter([{ path: '*', element }], { initialEntries: [o.url] });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ClockContext.Provider value={clock}>
        <TimeZoneContext.Provider value="Europe/London">
          <RouterProvider router={router} />
        </TimeZoneContext.Provider>
      </ClockContext.Provider>
    </QueryClientProvider>,
  );
  return { router, queryClient, clock, view };
}
