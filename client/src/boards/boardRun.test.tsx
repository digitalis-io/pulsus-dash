import { act, screen } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { useContext, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderRouted } from '../test/routedHarness';
import { BoardRunContext, BoardRunProvider } from './boardRun';
import type { WidthStore } from './panelWidths';

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

describe('panel widths (review r1 #3)', () => {
  it("a reused panel id does not inherit a deleted panel's width", async () => {
    let widths: WidthStore | null = null;
    let setLive: (ids: string[]) => void = () => undefined;
    function Probe() {
      widths = useContext(BoardRunContext).widths;
      return <p>probe</p>;
    }
    function Host() {
      const [live, set] = useState<string[]>(['p-1', 'p-2']);
      setLive = set;
      return (
        <BoardRunProvider tenant="demo" vars={new Map()} timeReady livePanels={live}>
          <Probe />
        </BoardRunProvider>
      );
    }
    renderRouted(<Host />, { url: '/?from=now-1h&to=now&refresh=off' });
    await screen.findByText('probe');
    act(() => {
      widths?.set('p-1', 400);
      widths?.set('p-2', 700);
    });
    // p-2 is deleted, then a new panel takes its id.
    act(() => {
      setLive(['p-1']);
    });
    act(() => {
      setLive(['p-1', 'p-2']);
    });
    const w = widths as WidthStore | null;
    expect(w?.get('p-2')).toBeNull();
    expect(w?.get('p-1')).toBe(400);
  });
});
