// unit:use-log-pager (plan #66 Part B §3.4, §5.3).
import { act, renderHook } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { scriptedLogsApi } from '../test/scriptedLogsApi';
import type { LogPagerInput } from './logPager';
import { useLogPager, useLogPagerState } from './useLogPager';

const input: LogPagerInput = {
  tenant: 'demo',
  query: '{app="x"}',
  fromMs: 1767225600000,
  toMs: 1767229200000,
  widthPx: 800,
  direction: 'backward',
};

describe('unit:use-log-pager', () => {
  it('U1 mount makes one call', () => {
    const api = scriptedLogsApi();
    const { result } = renderHook(() => useLogPager(input, api));
    expect(api.calls).toHaveLength(1);
    expect(result.current).not.toBeNull();
  });

  it('U2 an equal input object keeps the pager', () => {
    const api = scriptedLogsApi();
    const { result, rerender } = renderHook(({ i }) => useLogPager(i, api), {
      initialProps: { i: input },
    });
    const first = result.current;
    rerender({ i: { ...input } });
    expect(api.calls).toHaveLength(1);
    expect(result.current).toBe(first);
  });

  it('U3 another key aborts the old pager and starts one', () => {
    const api = scriptedLogsApi();
    const { rerender } = renderHook(({ i }) => useLogPager(i, api), {
      initialProps: { i: input },
    });
    rerender({ i: { ...input, toMs: input.toMs + 1 } });
    expect(api.calls).toHaveLength(2);
    expect(api.calls[0]?.signal?.aborted).toBe(true);
    expect(api.calls[1]?.signal?.aborted).toBe(false);
    expect(api.calls[1]?.req.toMs).toBe(input.toMs + 1);
  });

  it('U4 unmount aborts', () => {
    const api = scriptedLogsApi();
    const { unmount } = renderHook(() => useLogPager(input, api));
    unmount();
    expect(api.calls[0]?.signal?.aborted).toBe(true);
  });

  it('U5 StrictMode leaves exactly one live request', () => {
    const api = scriptedLogsApi();
    const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
    renderHook(() => useLogPager(input, api), { wrapper });
    expect(api.calls.filter((c) => c.signal?.aborted !== true)).toHaveLength(1);
  });

  it('the state follows the pager', async () => {
    const api = scriptedLogsApi();
    const { result } = renderHook(() => {
      const pager = useLogPager(input, api);
      return useLogPagerState(pager);
    });
    expect(result.current?.phase).toBe('pending');
    await act(() => api.reject(0, new Error('x')));
    expect(result.current?.phase).toBe('failed');
  });

  it('null input → null', () => {
    const api = scriptedLogsApi();
    const { result } = renderHook(() => useLogPagerState(useLogPager(null, api)));
    expect(result.current).toBeNull();
    expect(api.calls).toHaveLength(0);
  });
});
