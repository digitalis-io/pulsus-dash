// unit:use-logs-params (plan #66 Part C §3.1, §5.1; IA-022, T03-014).
import { act, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider, type DataRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { createClock } from './clock';
import { TimeZoneContext } from './timeZone';
import { useLogsParams } from './useLogsParams';
import { ClockContext } from './useTimeContext';

type Hook = ReturnType<typeof useLogsParams>;

function setup(url: string): { router: DataRouter; hook: () => Hook } {
  let last: Hook | null = null;
  function Probe() {
    last = useLogsParams();
    return null;
  }
  const router = createMemoryRouter([{ path: '/t/:tenant/explore/logs', Component: Probe }], {
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

const ABS = '?from=2026-11-19T12%3A00%3A00.000Z&to=2026-11-19T13%3A00%3A00.000Z&refresh=off';

describe('unit:use-logs-params', () => {
  it('reads the keys; dir replaces, q pushes, the Context is kept', async () => {
    const { router, hook } = setup(`/t/demo/explore/logs${ABS}&q=up`);
    expect(hook().params).toEqual({ q: 'up', dir: 'backward', wrap: false });

    await act(async () => {
      hook().set({ dir: 'forward' }, { replace: true });
      await Promise.resolve();
    });
    expect(router.state.location.search).toBe(`${ABS}&dir=forward&q=up`);
    // A replace: the history keeps its length (the memory router's index is unchanged).
    expect(router.state.historyAction).toBe('REPLACE');

    await act(async () => {
      hook().set({ q: '{a="b"}' }, { replace: false });
      await Promise.resolve();
    });
    expect(router.state.historyAction).toBe('PUSH');
    expect(new URLSearchParams(router.state.location.search).get('q')).toBe('{a="b"}');
    expect(new URLSearchParams(router.state.location.search).get('from')).toBe(
      '2026-11-19T12:00:00.000Z',
    );
    expect(hook().params).toEqual({ q: '{a="b"}', dir: 'forward', wrap: false });

    await act(async () => {
      hook().set({ wrap: true }, { replace: true });
      await Promise.resolve();
    });
    expect(router.state.historyAction).toBe('REPLACE');
    expect(hook().params.wrap).toBe(true);
  });
});
