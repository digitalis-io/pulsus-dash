import { act, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider, type DataRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { createClock } from './clock';
import { ClockContext } from './useTimeContext';
import { TimeZoneContext } from './timeZone';
import { useExploreParams } from './useExploreParams';

type Hook = ReturnType<typeof useExploreParams>;

function setup(url: string): { router: DataRouter; hook: () => Hook } {
  let last: Hook | null = null;
  function Probe() {
    last = useExploreParams();
    return null;
  }
  const router = createMemoryRouter([{ path: '/t/:tenant/explore/metrics', Component: Probe }], {
    initialEntries: [url],
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ClockContext.Provider value={createClock(() => Date.UTC(2026, 10, 19, 13, 3))}>
        <TimeZoneContext.Provider value="Europe/London">
          <RouterProvider router={router} />
        </TimeZoneContext.Provider>
      </ClockContext.Provider>
    </QueryClientProvider>,
  );
  return {
    router,
    hook: () => {
      if (last === null) throw new Error('not rendered');
      return last;
    },
  };
}

describe('useExploreParams', () => {
  it('reads the explore keys and writes them with replace or push', async () => {
    const base = '/t/demo/explore/metrics?from=now-1h&to=now&refresh=off';
    const { router, hook } = setup(`${base}&q=up`);
    expect(hook().params).toEqual({ q: 'up', vis: 'auto', rate: 'auto' });

    await act(async () => {
      hook().set({ vis: 'bars' }, { replace: true });
      await Promise.resolve();
    });
    expect(router.state.location.search).toBe('?from=now-1h&to=now&refresh=off&q=up&vis=bars');
    expect(router.state.historyAction).toBe('REPLACE');

    await act(async () => {
      hook().set({ q: 'x' }, { replace: false });
      await Promise.resolve();
    });
    expect(router.state.location.search).toBe('?from=now-1h&to=now&refresh=off&q=x&vis=bars');
    expect(router.state.historyAction).toBe('PUSH');

    await act(async () => {
      hook().set({ rate: 'off' }, { replace: false });
      await Promise.resolve();
    });
    expect(router.state.location.search).toBe(
      '?from=now-1h&to=now&refresh=off&q=x&rate=off&vis=bars',
    );
    expect(hook().params).toEqual({ q: 'x', vis: 'bars', rate: 'off' });
  });
});
