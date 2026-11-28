import { act, render, waitFor } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { StubApi } from '../api/StubApi';
import { Providers } from '../app/providers';
import { createScheduler } from '../data/rangeScheduler';
import { createRangeStore } from '../data/rangeStore';
import { promql } from '../editor/lang/promql/promql';
import { createClock } from '../state/clock';
import { fn, scriptedRange } from '../test/rangeApi';
import { exploreRunKey, refusalOf, runKind, runnable, useExploreRun } from './useExploreRun';

const W = { fromMs: 0, toMs: 3_600_000 };
/** `docOf(n)` is `n` UTF-8 bytes (Part B). */
const docOf = (n: number): string => '#' + 'a'.repeat(n - 10) + '\nup{job="';

describe('useExploreRun key', () => {
  it('U1: the key holds the raw text, the kind and the rate', () => {
    const on = exploreRunKey('demo', 'http_requests_total', 'range', true, W, 5000);
    expect(on).toEqual([
      'data',
      'explore',
      'demo',
      'http_requests_total',
      'range',
      true,
      0,
      3_600_000,
      5000,
    ]);
    const off = exploreRunKey('demo', 'http_requests_total', 'range', false, W, 5000);
    expect(off.map((v, i) => (v === on[i] ? null : i)).filter((i) => i !== null)).toEqual([5]);
  });

  it('U2: runKind', () => {
    expect(runKind('scalar(vector(1)) / 0', promql)).toBe('instant');
    expect(runKind('up', promql)).toBe('range');
    expect(runKind('  ', promql)).toBeNull();
    expect(runKind('up', null)).toBeNull();
    // Degraded (#147): without a language every non-blank text is a range query.
    expect(runKind('up', null, true)).toBe('range');
    expect(runKind('1 + 1', null, true)).toBe('range');
    expect(runKind('  ', null, true)).toBeNull();
    expect(runKind('1 + 1', promql, true)).toBe('instant');
  });

  it('U3: refusalOf', () => {
    expect(refusalOf(docOf(131_073))).toBe('queryTooLarge');
    expect(refusalOf('a'.repeat(70_000))).toBeNull();
  });

  it('U4: runnable needs the language and the step', () => {
    expect(runnable({ lang: promql, degraded: false, stepMs: 5000, rate: true })).toBe(true);
    expect(runnable({ lang: promql, degraded: false, stepMs: null, rate: true })).toBe(false);
    expect(runnable({ lang: null, degraded: false, stepMs: 5000, rate: true })).toBe(false);
    // Degraded (#147): the step is still needed, the language is not.
    expect(runnable({ lang: null, degraded: true, stepMs: 5000, rate: true })).toBe(true);
    expect(runnable({ lang: null, degraded: true, stepMs: null, rate: true })).toBe(false);
  });
});

describe('explore through store (#304 Part B §2)', () => {
  it('explore through store: a one-window pan issues no request', async () => {
    const B = 3_840_000;
    const H = 3_600_000;
    const T0 = 460_000 * B;
    const stub = new StubApi();
    const api = scriptedRange();
    api.auto = () => ({ series: [fn({ a: '1' }, () => 1)], scope: { epoch: 'stub', seq: 1 } });
    vi.spyOn(stub, 'queryRange').mockImplementation((t, r, s) => api.queryRange(t, r, s));
    const clock = { t: T0 + 30 * 86_400_000 };
    const store = createRangeStore({ api: stub, scheduler: createScheduler(), now: () => clock.t });
    store.observeScope('demo', { epoch: 'stub', seq: 1 }, clock.t);
    let pan: (w: { fromMs: number; toMs: number }) => void = () => undefined;
    let shown: unknown = null;
    function Run() {
      const [w, setW] = useState({ fromMs: T0, toMs: T0 + H });
      pan = setW;
      const run = useExploreRun({
        tenant: 'demo',
        q: 'up',
        inputs: { lang: null, degraded: true, stepMs: 15_000, rate: true },
        widthPx: 1200,
        window: w,
        anchorMs: clock.t,
        epoch: 0,
      });
      shown = run.shown;
      return null;
    }
    render(
      <Providers
        deps={{
          api: stub,
          queryClient: new QueryClient(),
          clock: createClock(() => clock.t),
          timeZone: 'UTC',
        }}
        rangeStore={store}
      >
        <Run />
      </Providers>,
    );
    await waitFor(() => {
      expect(api.calls.filter((c) => c.req.stepMs === 15_000)).toHaveLength(3);
    });
    const before = api.calls.length;
    act(() => {
      pan({ fromMs: T0 + H, toMs: T0 + 2 * H });
    });
    await waitFor(() => {
      expect(shown).not.toBeNull();
    });
    for (const c of api.calls.slice(before)) {
      expect(c.req.fromMs > T0 + 2 * H || c.req.toMs < T0 + H).toBe(true);
    }
  });
});
