// unit:logs-volume (plan #66 Part C §3.7, §5.1; PRF-030, SRF-033).
import { act, renderHook } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/types';
import { Providers } from '../app/providers';
import { createClock } from '../state/clock';
import { scriptedLogsPageApi, volumeAnswer } from '../test/logsPageKit';
import { T } from '../test/renderApp';
import type { StepWidth } from './stepWidth';
import { logsVolumeKey, useLogsVolume } from './useLogsVolume';

const W = { fromMs: Date.UTC(2026, 10, 19, 12), toMs: Date.UTC(2026, 10, 19, 13) };
const STEP: StepWidth = { stepMs: 5000, widthPx: 960 };

interface Props {
  tenant: string;
  q: string;
  window: { fromMs: number; toMs: number };
  step: StepWidth | null;
  enabled: boolean;
}

function setup(initial: Partial<Props> = {}) {
  const s = scriptedLogsPageApi();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const deps = { api: s.api, queryClient, clock: createClock(() => T), timeZone: 'Europe/London' };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Providers deps={deps}>{children}</Providers>
  );
  const props: Props = {
    tenant: 'demo',
    q: '{app="a"} |= "x"',
    window: W,
    step: STEP,
    enabled: true,
    ...initial,
  };
  const r = renderHook((p: Props) => useLogsVolume(p), { wrapper, initialProps: props });
  return { ...s, ...r, props };
}

describe('unit:logs-volume', () => {
  it('the key', () => {
    expect(logsVolumeKey('demo', 'q', W, 5000)).toEqual([
      'data',
      'logs',
      'volume',
      'demo',
      'q',
      W.fromMs,
      W.toMs,
      5000,
    ]);
  });

  it('one call with the raw text, the window and the width', async () => {
    const { volume, result } = setup();
    expect(volume).toHaveLength(1);
    expect(volume[0]?.tenant).toBe('demo');
    expect(volume[0]?.req).toEqual({
      query: '{app="a"} |= "x"',
      fromMs: W.fromMs,
      toMs: W.toMs,
      widthPx: 960,
    });
    expect(result.current.fetching).toBe(true);
    const v = volumeAnswer();
    await volume[0]?.resolve(v);
    expect(result.current.shown).toBe(v);
    expect(result.current.fetching).toBe(false);
  });

  it('a key change aborts the old request', () => {
    const { volume, rerender, props } = setup();
    rerender({ ...props, window: { fromMs: W.fromMs + 60_000, toMs: W.toMs } });
    expect(volume).toHaveLength(2);
    expect(volume[0]?.signal?.aborted).toBe(true);
    expect(volume[1]?.signal?.aborted).toBe(false);
  });

  it('rerun() aborts the request in flight and fetches again', async () => {
    const { volume, result } = setup();
    act(() => {
      result.current.rerun();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(volume[0]?.signal?.aborted).toBe(true);
    expect(volume).toHaveLength(2);
    expect(volume[1]?.req).toEqual(volume[0]?.req);
  });

  it('an error keeps the shown volume', async () => {
    const { volume, result, rerender, props } = setup();
    const v = volumeAnswer();
    await volume[0]?.resolve(v);
    rerender({ ...props, window: { fromMs: W.fromMs + 60_000, toMs: W.toMs } });
    const e = new ApiError('unavailable', 'down');
    await volume[1]?.reject(e);
    expect(result.current.error).toBe(e);
    expect(result.current.shown).toBe(v);
  });

  it('another tenant shows nothing until its own success', async () => {
    const { volume, result, rerender, props } = setup();
    await volume[0]?.resolve(volumeAnswer());
    rerender({ ...props, tenant: 'other' });
    expect(volume).toHaveLength(2);
    expect(volume[1]?.tenant).toBe('other');
    expect(result.current.shown).toBeNull();
    const w = volumeAnswer(['warn']);
    await volume[1]?.resolve(w);
    expect(result.current.shown).toBe(w);
  });

  it('disabled: no call, nothing shown', () => {
    const { volume, result } = setup({ enabled: false });
    expect(volume).toHaveLength(0);
    expect(result.current.shown).toBeNull();
    expect(result.current.fetching).toBe(false);
  });

  it('no step: no call', () => {
    const { volume } = setup({ step: null });
    expect(volume).toHaveLength(0);
  });
});
