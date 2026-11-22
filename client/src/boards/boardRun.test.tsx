import { act, screen } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderRouted } from '../test/routedHarness';
import { BoardRunProvider } from './boardRun';

describe('epoch mark', () => {
  it('epoch mark', async () => {
    const queryClient = new QueryClient();
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    let setReady: (v: boolean) => void = () => undefined;
    let rerender: () => void = () => undefined;
    function Host() {
      const [ready, set] = useState(false);
      const [, bump] = useState(0);
      setReady = set;
      rerender = () => {
        bump((n) => n + 1);
      };
      return (
        <BoardRunProvider tenant="demo" vars={new Map()} timeReady={ready}>
          <p>child</p>
        </BoardRunProvider>
      );
    }
    const { router } = renderRouted(<Host />, {
      url: '/?from=2026-11-19T12:00:00.000Z&to=2026-11-19T13:00:00.000Z&refresh=off',
      queryClient,
    });
    await screen.findByText('child');
    expect(spy).not.toHaveBeenCalled();
    act(() => {
      setReady(true);
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenLastCalledWith({
      queryKey: ['data', 'panel', 'demo'],
      refetchType: 'none',
    });
    await act(async () => {
      await router.navigate(
        '/?from=2026-11-19T13:00:00.000Z&to=2026-11-19T14:00:00.000Z&refresh=off',
      );
    });
    expect(spy).toHaveBeenCalledTimes(2);
    act(() => {
      rerender();
    });
    await act(async () => {
      await router.navigate(
        '/?from=2026-11-19T13:00:00.000Z&to=2026-11-19T14:00:00.000Z&refresh=10s',
      );
    });
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
