/**
 * The store-backed panel run (#304 §4.1–§4.6, Part B §4.3): pans from held data, cancellation,
 * sharing, the cap shared with every board range request, scope and lease, bypass, ranks.
 */
import { act, render, waitFor } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { createMemoryRouter, RouterProvider, type DataRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { StubApi } from '../api/StubApi';
import type { DataPanelSpec, LogsRequest } from '../api/types';
import { Providers } from '../app/providers';
import type { LogsResult } from '../data/decode';
import type { FrameData } from '../data/frames';
import { createScheduler } from '../data/rangeScheduler';
import { LEASE_MS, createRangeStore, type RangeStore } from '../data/rangeStore';
import { ChartEngineContext } from '../engine/index';
import { createClock } from '../state/clock';
import { fakeEngine } from '../test/fakeEngine';
import { installResizeObserver } from '../test/fakeResizeObserver';
import { drain, fn, scriptedRange, type FnSeries, type RangeCall } from '../test/rangeApi';
import { BoardRunProvider } from './boardRun';
import { panelView, type PanelView } from './panelRun';
import { usePanelRun, type PanelRun } from './usePanelRun';

const H = 3_600_000;
const B = 3_840_000;
const DAY = 86_400_000;
/** A bucket-aligned start in 2025 at the 15 s step. */
const K0 = 460_000;
const T0 = K0 * B;
const STUB = { epoch: 'stub', seq: 1 };
const iso = (ms: number) => new Date(ms).toISOString();
const url = (fromMs: number, toMs: number) =>
  `/t/demo/x?from=${iso(fromMs)}&to=${iso(toMs)}&refresh=off`;

const panel = (
  id: string,
  text: string,
  vis: DataPanelSpec['vis'] = { kind: 'line' },
): DataPanelSpec => ({
  id,
  title: id,
  grid: { x: 0, y: 0, w: 6, h: 6 },
  query: { lang: 'promql', text },
  vis,
});

interface Rec {
  run: PanelRun | null;
  views: PanelView[];
}

interface Mounted {
  readonly api: ReturnType<typeof scriptedRange>;
  readonly store: RangeStore;
  readonly clock: { t: number };
  readonly router: DataRouter;
  readonly recs: Map<string, Rec>;
  readonly logs: { req: LogsRequest; signal: AbortSignal | undefined }[];
  readonly inflight: () => number;
  readonly maxInflight: () => number;
  rerenderProviders(): void;
  go(fromMs: number, toMs: number): Promise<void>;
}

function mount(
  panels: readonly DataPanelSpec[],
  window: { fromMs: number; toMs: number },
  o: { degraded?: boolean } = {},
): Mounted {
  installResizeObserver();
  const stub = new StubApi();
  const api = scriptedRange();
  let inflight = 0;
  let maxInflight = 0;
  const track = <T,>(p: Promise<T>): Promise<T> => {
    inflight++;
    maxInflight = Math.max(maxInflight, inflight);
    return p.finally(() => {
      inflight--;
    });
  };
  vi.spyOn(stub, 'queryRange').mockImplementation((t, req, signal) =>
    track(api.queryRange(t, req, signal)),
  );
  const logs: { req: LogsRequest; signal: AbortSignal | undefined }[] = [];
  vi.spyOn(stub, 'queryLogs').mockImplementation((_t, req, signal) =>
    track(
      new Promise<LogsResult>((_resolve, reject) => {
        logs.push({ req, signal });
        signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      }),
    ),
  );
  // The clock (anchor and lease) a month after the windows: every right flank is in the past.
  const clock = { t: T0 + 30 * DAY };
  const store = createRangeStore({ api: stub, scheduler: createScheduler(), now: () => clock.t });
  // The bootstrap the app always has before a board (its tenants' scope, §4.5).
  store.observeScope('demo', STUB, clock.t);
  const recs = new Map<string, Rec>();
  function Run({ p }: { p: DataPanelSpec }) {
    const run = usePanelRun({
      tenant: 'demo',
      panel: p,
      text: p.query.text,
      enabled: true,
      widthPx: 1200,
      ...(o.degraded === true ? { degraded: true } : {}),
    });
    const view = panelView(run, p.vis, p.id);
    let rec = recs.get(p.id);
    if (rec === undefined) {
      rec = { run: null, views: [] };
      recs.set(p.id, rec);
    }
    rec.run = run;
    if (rec.views.at(-1) !== view) rec.views.push(view);
    return <div data-run={p.id} data-store={run.store} data-view={view.kind} />;
  }
  const engine = fakeEngine();
  const router = createMemoryRouter(
    [
      {
        path: '/t/:tenant/x',
        element: (
          <ChartEngineContext.Provider value={engine}>
            <BoardRunProvider tenant="demo" vars={new Map()} timeReady>
              {panels.map((p) => (
                <Run key={p.id} p={p} />
              ))}
            </BoardRunProvider>
          </ChartEngineContext.Provider>
        ),
      },
    ],
    { initialEntries: [url(window.fromMs, window.toMs)] },
  );
  const queryClient = new QueryClient();
  let bump: () => void = () => undefined;
  function Host() {
    const [, set] = useState(0);
    bump = () => {
      set((n) => n + 1);
    };
    return (
      <Providers
        deps={{ api: stub, queryClient, clock: createClock(() => clock.t), timeZone: 'UTC' }}
        rangeStore={store}
      >
        <RouterProvider router={router} />
      </Providers>
    );
  }
  render(<Host />);
  return {
    api,
    store,
    clock,
    router,
    recs,
    logs,
    inflight: () => inflight,
    maxInflight: () => maxInflight,
    rerenderProviders: () => {
      act(() => {
        bump();
      });
    },
    go: async (fromMs, toMs) => {
      await act(async () => {
        await router.navigate(url(fromMs, toMs));
      });
    },
  };
}

const meets = (c: RangeCall, fromMs: number, toMs: number) =>
  c.req.fromMs <= toMs && c.req.toMs >= fromMs;
const seriesOf = (
  v: PanelView | undefined,
): readonly { labels: Readonly<Record<string, string>> }[] =>
  v?.kind === 'frame' && v.data.kind === 'series' ? v.data.series : [];
const answer = (series: readonly FnSeries[]) => () => ({ series, scope: STUB });
const ONE = [fn({ a: '1' }, (t) => 1 + ((t / 60_000) % 60) / 10)];

describe('store-backed panel run (#304 §4.1)', () => {
  it('pan issues no query', async () => {
    const m = mount([panel('p', 'up')], { fromMs: T0, toMs: T0 + H });
    m.api.auto = answer(ONE);
    await waitFor(() => {
      expect(m.recs.get('p')?.run?.outcome?.held).toBeDefined();
    });
    await drain();
    await waitFor(() => {
      expect(m.api.calls.filter((c) => c.req.stepMs === 15_000)).toHaveLength(3);
    });
    const before = m.api.calls.length;
    await m.go(T0 + H, T0 + 2 * H);
    // The first render after the commit holds the new window.
    const o = m.recs.get('p')?.run?.outcome;
    expect(o?.key[8]).toBe(T0 + H);
    expect(
      o?.held?.kind === 'series' ? o.held.series[0]?.timestamps[0] : undefined,
    ).toBeLessThanOrEqual(T0 + H);
    await drain();
    for (const c of m.api.calls.slice(before)) {
      expect(meets(c, T0 + H, T0 + 2 * H)).toBe(false);
      expect(c.req.priority).toBe('low');
      expect(c.req.fromMs).toBeGreaterThan(T0 + 2 * H);
    }
    expect(m.recs.get('p')?.run?.store).toBe('held');
  });

  it('ten changes, nine cancelled', async () => {
    const m = mount([panel('p', 'up')], { fromMs: T0, toMs: T0 + H });
    await drain();
    for (let i = 1; i < 10; i++) await m.go(T0 + i * DAY, T0 + i * DAY + H);
    await drain();
    const visible = m.api.calls.filter((c) => c.req.priority === 'high');
    expect(visible).toHaveLength(10);
    expect(visible.filter((c) => c.signal?.aborted === true)).toHaveLength(9);
    visible[9]?.respond({ series: ONE, scope: STUB });
    await waitFor(() => {
      expect(m.recs.get('p')?.run?.outcome?.key[8]).toBe(T0 + 9 * DAY);
    });
  });

  it('shared across panels', async () => {
    const m = mount([panel('a', 'up'), panel('b', 'up')], { fromMs: T0, toMs: T0 + H });
    await drain();
    expect(m.api.calls.filter((c) => c.req.priority === 'high')).toHaveLength(1);
    m.api.open()[0]?.respond({ series: ONE, scope: STUB });
    await waitFor(() => {
      expect(m.recs.get('a')?.run?.outcome).not.toBeNull();
      expect(m.recs.get('b')?.run?.outcome).not.toBeNull();
    });
  });

  it('ineligible unchanged, placeholder kept', async () => {
    const m = mount(
      [
        panel('s', 'rate(x[5m] @ start())'),
        panel('g', 'up', { kind: 'barchart', options: { baselineOffset: '1d' } }),
      ],
      { fromMs: T0, toMs: T0 + H },
    );
    m.api.auto = answer(ONE);
    await waitFor(() => {
      expect(m.recs.get('s')?.run?.outcome).not.toBeNull();
      expect(m.recs.get('g')?.run?.outcome).not.toBeNull();
    });
    for (const c of m.api.calls) expect(c.req.stepMs).toBeUndefined();
    expect(m.recs.get('s')?.run?.store).toBe('off');
    const prev = m.recs.get('s')?.run?.outcome;
    m.api.auto = null;
    await m.go(T0 + DAY, T0 + DAY + H);
    expect(m.recs.get('s')?.run?.outcome).toBe(prev);
  });

  it('mixed panels share the cap', async () => {
    const m = mount(
      [
        panel('a', 'up{a="1"}'),
        panel('b', 'up{a="2"}'),
        panel('c', 'up{a="3"}'),
        panel('d', 'rate(x[5m] @ start())'),
        panel('e', 'rate(y[5m] @ start())'),
        panel('f', 'up', { kind: 'barchart', options: { baselineOffset: '1d' } }),
        panel('g', 'down', { kind: 'barchart', options: { baselineOffset: '1d' } }),
        {
          ...panel('h', 'sum(count_over_time({app="x"}[1m]))'),
          query: { lang: 'logql', text: 'sum(count_over_time({app="x"}[1m]))' },
        },
      ],
      { fromMs: T0, toMs: T0 + H },
    );
    await drain(10);
    expect(m.inflight()).toBe(6);
    expect(m.maxInflight()).toBeLessThanOrEqual(6);
  });

  it('oversized view bypasses', async () => {
    const many: FnSeries[] = Array.from({ length: 2_000 }, (_, i) => fn({ i: String(i) }, () => i));
    const m = mount([panel('p', 'up')], { fromMs: T0, toMs: T0 + 1_200 * 15_000 });
    m.api.auto = answer(many);
    await waitFor(() => {
      expect(m.recs.get('p')?.run?.store).toBe('bypass');
    });
    await waitFor(() => {
      expect(seriesOf(m.recs.get('p')?.views.at(-1))).toHaveLength(2_000);
    });
    const single = m.api.calls.filter((c) => c.req.stepMs === undefined);
    expect(single).toHaveLength(1);
    expect(document.querySelector('[data-run="p"]')).toHaveAttribute('data-store', 'bypass');
  });
});

describe('scope and lease in the panel run (#304 §4.5)', () => {
  const both = [fn({ team: 'a' }, () => 1), fn({ team: 'b' }, () => 2)];

  it('scope narrowed in session', async () => {
    const m = mount([panel('p', 'up')], { fromMs: T0, toMs: T0 + H });
    m.api.auto = answer(both);
    await waitFor(() => {
      expect(m.api.calls.filter((c) => c.req.stepMs === 15_000)).toHaveLength(3);
    });
    await drain();
    m.api.auto = null;
    await m.go(T0 + H, T0 + 2 * H);
    expect(seriesOf(m.recs.get('p')?.views.at(-1)).map((s) => s.labels['team'])).toContain('b');
    await drain();
    const flank = m.api.open().at(-1);
    const B2 = { epoch: 'stub2', seq: 2 };
    const at = m.recs.get('p')?.views.length ?? 0;
    // Refetched under B: only team a.
    m.api.auto = () => ({ series: [both[0] as FnSeries], scope: B2 });
    await act(async () => {
      flank?.respond({ series: [both[0] as FnSeries], scope: B2 });
      await drain();
    });
    await waitFor(() => {
      expect(seriesOf(m.recs.get('p')?.views.at(-1))).toHaveLength(1);
    });
    for (const v of m.recs.get('p')?.views.slice(at + 1) ?? []) {
      expect(seriesOf(v).map((s) => s.labels['team'])).not.toContain('b');
    }
  });

  it('mounted panel after lease expiry paints nothing cached before revalidation', async () => {
    const m = mount([panel('p', 'up')], { fromMs: T0, toMs: T0 + H });
    m.api.auto = answer(ONE);
    await waitFor(() => {
      expect(m.api.calls.filter((c) => c.req.stepMs === 15_000)).toHaveLength(3);
    });
    m.api.auto = null;
    const n = m.api.calls.length;
    m.clock.t += LEASE_MS + 1;
    act(() => {
      m.store.tick();
    });
    await drain();
    expect(m.recs.get('p')?.run?.outcome).toBeNull();
    const re = m.api.calls.slice(n).filter((c) => c.req.priority === 'high');
    expect(re).toHaveLength(1);
    re[0]?.respond({ series: ONE, scope: STUB });
    await waitFor(() => {
      expect(m.recs.get('p')?.run?.outcome).not.toBeNull();
    });
  });

  it('a pan after lease expiry with provider rerenders paints nothing cached first', async () => {
    const m = mount([panel('p', 'up')], { fromMs: T0, toMs: T0 + H });
    m.api.auto = answer(ONE);
    await waitFor(() => {
      expect(m.api.calls.filter((c) => c.req.stepMs === 15_000)).toHaveLength(3);
    });
    m.api.auto = null;
    m.clock.t += LEASE_MS + 1;
    // A provider rerender re-observes the bootstrap: its original receipt time, no renewal.
    m.rerenderProviders();
    m.rerenderProviders();
    expect(m.store.leaseValid('demo')).toBe(false);
    const views = m.recs.get('p')?.views.length ?? 0;
    await m.go(T0 + H, T0 + 2 * H);
    await drain();
    const after = m.recs.get('p')?.views.slice(views) ?? [];
    expect(after.every((v) => v.kind !== 'frame')).toBe(true);
    // The revalidation of the mounted window and the pan's visible run: all interactive.
    const re = m.api.open();
    expect(re.length).toBeGreaterThan(0);
    expect(re.every((c) => c.req.priority === 'high')).toBe(true);
    for (const c of re) c.respond({ series: ONE, scope: STUB });
    await waitFor(() => {
      expect(m.recs.get('p')?.views.at(-1)?.kind).toBe('frame');
    });
  });
});

describe('ranks in the panel run (#304 Part B §4.3)', () => {
  const centred = (c: number, span: number) => ({ fromMs: c - span / 2, toMs: c + span / 2 });
  const frameData = (v: PanelView | undefined): FrameData | null =>
    v?.kind === 'frame' ? v.data : null;

  it('zoom-out 3× hits ladder', async () => {
    const c = T0 + 12 * H;
    const w = centred(c, 6 * H);
    const m = mount([panel('p', 'up')], w);
    m.api.auto = answer(ONE);
    await waitFor(
      () => {
        expect(m.api.calls.filter((x) => x.req.stepMs === 120_000)).toHaveLength(1);
      },
      { timeout: 3_000 },
    );
    await drain();
    const n = m.api.calls.length;
    const z = centred(c, 18 * H);
    await m.go(z.fromMs, z.toMs);
    expect(m.recs.get('p')?.run?.rank).toBe(1);
    await drain();
    for (const x of m.api.calls.slice(n))
      expect(meets(x, z.fromMs, z.toMs) && x.req.stepMs === 60_000).toBe(false);
  });

  it('zoom-in paints rank 0', async () => {
    const c = T0 + 48 * H;
    const w = centred(c, 24 * H);
    const m = mount([panel('p', 'up')], w);
    m.api.auto = answer(ONE);
    await waitFor(
      () => {
        expect(m.api.calls.filter((x) => x.req.stepMs === 600_000)).toHaveLength(1);
      },
      { timeout: 3_000 },
    );
    await drain();
    m.api.auto = null;
    const n = m.api.calls.length;
    const z = centred(c, 6 * H);
    await m.go(z.fromMs, z.toMs);
    const first = m.recs.get('p')?.run;
    expect(first?.rank).toBe(0);
    const d = frameData(m.recs.get('p')?.views.at(-1));
    expect(d?.kind === 'series' ? d.series[0]?.values.some(Number.isFinite) : false).toBe(true);
    await drain();
    const fine = m.api.calls
      .slice(n)
      .filter((x) => x.req.stepMs === 15_000 && x.req.priority === 'high');
    expect(fine).toHaveLength(1);
    fine[0]?.respond({ series: ONE, scope: STUB });
    await waitFor(() => {
      expect(m.recs.get('p')?.run?.rank).toBe(1);
    });
    const last = frameData(m.recs.get('p')?.views.at(-1));
    expect(last?.kind === 'series' ? last.transition : undefined).toBe('crossfade');
  });

  it('pan cuts', async () => {
    const m = mount([panel('p', 'up')], { fromMs: T0, toMs: T0 + H });
    m.api.auto = answer(ONE);
    await waitFor(() => {
      expect(m.api.calls.length).toBeGreaterThanOrEqual(3);
    });
    await drain();
    await m.go(T0 + H, T0 + 2 * H);
    const d = frameData(m.recs.get('p')?.views.at(-1));
    expect(d?.kind === 'series' ? d.transition : 'none').toBeUndefined();
  });
});
