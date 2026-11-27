/** `unit:list-announce` (plan #216 Part 2a §4.5; T08-018): one polite write per 2 s, latest wins. */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ANNOUNCE_GAP_MS, useListAnnouncer } from './announce';

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('unit:list-announce', () => {
  it('writes at most once per 2 s; the latest pending text wins; a repeat is dropped', () => {
    expect(ANNOUNCE_GAP_MS).toBe(2000);
    const h = renderHook(() => useListAnnouncer());
    const log: string[] = [];
    let last = '';
    const watch = () => {
      if (h.result.current.text !== last) {
        last = h.result.current.text;
        log.push(`${String(Date.now())}:${last}`);
      }
    };
    act(() => {
      h.result.current.announce('a');
    });
    watch();
    act(() => {
      vi.advanceTimersByTime(500);
      h.result.current.announce('b');
    });
    watch();
    act(() => {
      vi.advanceTimersByTime(400);
      h.result.current.announce('c');
    });
    watch();
    for (let t = 900; t < 4500; t += 100) {
      act(() => {
        vi.advanceTimersByTime(100);
      });
      watch();
    }
    act(() => {
      h.result.current.announce('c');
    });
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    watch();
    expect(log).toEqual(['0:a', '2000:c']);
  });

  it('unmount clears the timer', () => {
    const h = renderHook(() => useListAnnouncer());
    act(() => {
      h.result.current.announce('a');
      h.result.current.announce('b');
    });
    expect(vi.getTimerCount()).toBe(1);
    h.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
