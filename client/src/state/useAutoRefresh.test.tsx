import { act, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderApp, T } from '../test/renderApp';
import { createClock } from './clock';

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});

describe('auto-refresh', () => {
  it('ticks every interval while visible and stops when off', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const clock = createClock(() => T);
    const tick = vi.spyOn(clock, 'tick');
    const { router } = renderApp('/t/demo/boards?from=now-1h&to=now&refresh=10s', { clock });
    await screen.findByRole('heading', { level: 1, name: 'Boards' });
    tick.mockClear();

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(tick).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(tick).toHaveBeenCalledTimes(4);

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(tick).toHaveBeenCalledTimes(4);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });

    await act(async () => {
      await router.navigate('/t/demo/boards?from=now-1h&to=now&refresh=off', { replace: true });
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(tick).toHaveBeenCalledTimes(4);
  });
});
