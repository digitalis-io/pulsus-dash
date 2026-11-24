import { act, screen } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { renderRouted } from '../test/routedHarness';
import { T } from '../test/renderApp';
import { createClock } from './clock';
import { useTimeContext, type TimeContext } from './useTimeContext';

describe('refreshNow rule', () => {
  it.each([
    ['ABS', 'from=2026-11-19T12:00:00.000Z&to=2026-11-19T13:00:00.000Z&refresh=off', true],
    // `now/d` to `now/d` is empty (the default window then applies): `now/d` to the next midnight
    // is the relative range a tick does not move (plan #64 R2).
    ['now/d', 'from=now/d&to=2026-11-20T00:00:00.000Z&refresh=off', true],
    ['REL', 'from=now-1h&to=now&refresh=off', false],
  ] as const)('refreshNow rule: %s', async (_name, search, same) => {
    const queryClient = new QueryClient();
    const cancel = vi.spyOn(queryClient, 'cancelQueries');
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    let now = T;
    const clock = createClock(() => now);
    let ctx: TimeContext | null = null;
    function Probe() {
      ctx = useTimeContext();
      return <p>probe</p>;
    }
    renderRouted(<Probe />, { url: `/?${search}`, queryClient, clock });
    await screen.findByText('probe');
    now += 1_000;
    act(() => {
      ctx?.refreshNow();
    });
    if (same) {
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(cancel).toHaveBeenCalledWith({ queryKey: ['data'] });
      expect(invalidate).toHaveBeenCalledTimes(1);
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['data'] });
    } else {
      expect(cancel).not.toHaveBeenCalled();
      expect(invalidate).not.toHaveBeenCalled();
    }
  });
});

describe('unit:refresh-epoch', () => {
  async function probe(search: string, nowFn: () => number) {
    const clock = createClock(nowFn);
    let ctx: TimeContext | null = null;
    function Probe() {
      ctx = useTimeContext();
      return <p>probe</p>;
    }
    renderRouted(<Probe />, { url: `/?${search}`, queryClient: new QueryClient(), clock });
    await screen.findByText('probe');
    const get = (): TimeContext => {
      if (ctx === null) throw new Error('not rendered');
      return ctx;
    };
    return get;
  }

  it('an absolute window: Refresh now moves the epoch', async () => {
    const get = await probe(
      'from=2026-11-19T12:00:00.000Z&to=2026-11-19T13:00:00.000Z&refresh=off',
      () => T,
    );
    expect(get().refreshEpoch).toBe(0);
    act(() => {
      get().refreshNow();
    });
    expect(get().refreshEpoch).toBe(1);
  });

  it('now-1h with a clock that advanced: the window moves, the epoch does not', async () => {
    let now = T;
    const get = await probe('from=now-1h&to=now&refresh=off', () => now);
    const before = get().window;
    now += 60_000;
    act(() => {
      get().refreshNow();
    });
    expect(get().window.toMs).toBe(before.toMs + 60_000);
    expect(get().refreshEpoch).toBe(0);
  });

  it('now-1h with a frozen clock: the window stays, the epoch moves', async () => {
    const get = await probe('from=now-1h&to=now&refresh=off', () => T);
    const before = get().window;
    act(() => {
      get().refreshNow();
    });
    expect(get().window).toEqual(before);
    expect(get().refreshEpoch).toBe(1);
  });
});
