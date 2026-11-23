/**
 * Board PromQL panels (plan #64 §5.1): the run, auto-vis, the states before a request, visible-only
 * queries, the window epoch and refresh (#101). The variables, errors, the panel menu, the panel
 * editor's query field and the board time are in `BoardPanelsMenu.test.tsx`.
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StubApi } from '../../api/StubApi';
import type { InstantRequest, PanelSpec } from '../../api/types';
import type { InstantResult, RangeResult } from '../../data/decode';
import type { FrameData } from '../../data/frames';
import { resetQueryLanguages } from '../../boards/useQueryLanguage';
import {
  ABS,
  calls,
  editorOn,
  flush,
  frameOf,
  hide,
  holdRange,
  lastData,
  openBoard,
  preview,
  ready,
  REL,
  reqs,
  seriesValues,
  settled,
  settledLanguage,
  show,
  signals,
  T12,
  T13,
  windowKey,
} from '../../test/boardPanelKit';
import { deferred, panel, panelOf, panelState } from '../../test/boardTestKit';
import { fakeEditorSource } from '../../test/fakeEditor';
import {
  installIntersectionObserver,
  observedCount,
  uninstallIntersectionObserver,
} from '../../test/fakeIntersectionObserver';
import { F } from '../../test/fakePromSource';
import { installResizeObserver, resizeAll } from '../../test/fakeResizeObserver';
import { R_A, R_B, R_H1 } from '../../test/rangeFixtures';
import { T } from '../../test/renderApp';

vi.mock('../../editor/editor', () => import('../../test/fakeEditor'));

/** The PromQL language import, held or rejected by a test (plan §5.1 `waits for language…`). */
const lang = vi.hoisted(() => ({ hold: null as Promise<void> | null, reject: false }));
vi.mock('../../editor/lang/index', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../editor/lang/index')>();
  return {
    ...m,
    LANGUAGES: Object.freeze({
      ...m.LANGUAGES,
      promql: async () => {
        if (lang.reject) throw new Error('stub: language failed');
        if (lang.hold !== null) await lang.hold;
        return m.LANGUAGES.promql();
      },
    }),
  };
});

beforeEach(() => {
  installResizeObserver();
  installIntersectionObserver();
  lang.hold = null;
  lang.reject = false;
  resetQueryLanguages();
  fakeEditorSource.data = F;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});

describe('panel runs', () => {
  it('panel runs its PromQL query', async () => {
    const t = openBoard([panel('p-1', 'Requests', 'http_requests_total')]);
    await ready('Requests');
    show('Requests');
    await calls(t, 1);
    expect(reqs(t)[0]).toEqual({
      query: 'http_requests_total',
      fromMs: T12,
      toMs: T13,
      widthPx: 1000,
      vars: {},
      rate: true,
    });
    const r = await (t.range.mock.results[0]?.value as Promise<RangeResult>);
    expect(r.planned.query).toBe('rate(http_requests_total[1m])');
    await waitFor(() => {
      expect(panelOf('Requests')).toHaveAttribute('data-panel-vis', 'line');
    });
    expect(within(panelOf('Requests')).getByText('in /s')).toBeInTheDocument();
    expect(t.instant).not.toHaveBeenCalled();
  });

  it('auto-vis per panel and the override', async () => {
    const hist = 'sum by (le) (rate(http_request_duration_seconds_bucket[5m]))';
    const t = openBoard([
      panel('p-1', 'Counter', 'http_requests_total'),
      panel('p-2', 'Histogram', hist),
      panel('p-3', 'Gauge', 'node_memory_free_bytes'),
      panel('p-4', 'Counter stat', 'http_requests_total', 'stat'),
    ]);
    t.range.mockImplementation((tenant, req, s) =>
      req.query.includes('_bucket')
        ? Promise.resolve(R_H1)
        : StubApi.prototype.queryRange.call(t.api, tenant, req, s),
    );
    await ready('Counter', 'Histogram', 'Gauge', 'Counter stat');
    show('Counter', 'Histogram', 'Gauge', 'Counter stat');
    await calls(t, 4);
    const vis = { Counter: 'line', Histogram: 'heatmap', Gauge: 'line', 'Counter stat': 'stat' };
    for (const [title, kind] of Object.entries(vis)) {
      await waitFor(() => {
        expect(panelOf(title), title).toHaveAttribute('data-panel-vis', kind);
      });
    }
    await waitFor(() => {
      expect(lastData(t, 'Histogram')?.kind).toBe('heatmap');
    });
    const last = lastData(t, 'Histogram');
    if (last?.kind !== 'heatmap') throw new Error('no heatmap');
    expect(Array.from(last.heatmap.bounds)).toEqual([0.1, 0.5, Infinity]);
  });

  it('vis change is a redraw', async () => {
    const t = openBoard([panel('p-1', 'Requests', 'http_requests_total')]);
    await ready('Requests');
    show('Requests');
    await settled(t, 'Requests');
    const d = await editorOn(t, 'Requests');
    await t.user.click(within(d).getByRole('button', { name: /Visualisation$/ }));
    expect(await screen.findByRole('option', { name: 'Auto (Line)' })).toBeInTheDocument();
    await t.user.click(screen.getByRole('option', { name: 'Bars' }));
    expect(t.range).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      const p = preview(d);
      const f = t.engine.frames.findLast((x) => x.disposed === 0 && p.contains(x.canvas));
      expect((f?.last('setSpec')?.[0] as { kind?: string } | undefined)?.kind).toBe('bars');
    });
    expect(t.range).toHaveBeenCalledTimes(1);
  });

  it('scalar panel is an instant query', async () => {
    const t = openBoard([panel('p-1', 'Ratio', 'scalar(vector(1)) / 0')]);
    await ready('Ratio');
    show('Ratio');
    await waitFor(() => {
      expect(t.instant).toHaveBeenCalledTimes(1);
    });
    expect(t.instant.mock.calls[0]?.[1]).toEqual({
      query: 'scalar(vector(1)) / 0',
      atMs: T13,
      vars: {},
      stepMs: 5000,
    } satisfies InstantRequest);
    const r = await (t.instant.mock.results[0]?.value as Promise<InstantResult>);
    expect(r.kind).toBe('scalar');
    expect(t.range).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(panelOf('Ratio')).toHaveAttribute('data-panel-vis', 'stat');
    });
  });

  it('states without a request', async () => {
    const logql: PanelSpec = {
      ...panel('p-2', 'Logs', '{app="a"}'),
      query: { lang: 'logql', text: '{app="a"}' },
    };
    const t = openBoard([
      panel('p-1', 'Empty', ''),
      logql,
      panel('p-3', 'Stream', 'up', 'logs'),
      panel('p-4', 'Region', 'up{r="$region"}'),
    ]);
    await ready('Empty', 'Logs', 'Stream', 'Region');
    show('Empty', 'Logs', 'Stream', 'Region');
    const texts = {
      Empty: 'Add a query',
      Logs: 'Runs when LogQL support lands',
      Stream: 'A metric query has no log lines. Choose Auto or a chart.',
      Region: 'Set a value for $region to run this panel',
    };
    for (const [title, text] of Object.entries(texts)) {
      expect(await within(panelOf(title)).findByText(text), title).toBeInTheDocument();
    }
    await settledLanguage();
    expect(t.range).not.toHaveBeenCalled();
    expect(t.instant).not.toHaveBeenCalled();
    cleanup();

    lang.reject = true;
    resetQueryLanguages();
    const u = openBoard([panel('p-1', 'Broken', 'x')]);
    await ready('Broken');
    show('Broken');
    expect(
      await within(panelOf('Broken')).findByText(
        'PromQL support could not be loaded. Reload the page.',
      ),
    ).toBeInTheDocument();
    await flush();
    expect(u.range).not.toHaveBeenCalled();
    expect(panelState('Broken')).toBe('langFailed');
  });

  it('waits for language and width', async () => {
    const gate = deferred<undefined>();
    lang.hold = gate.promise.then(() => undefined);
    const t = openBoard([panel('p-1', 'Up', 'up')]);
    await ready('Up');
    show('Up');
    await flush();
    expect(t.range).not.toHaveBeenCalled();
    gate.resolve(undefined);
    await calls(t, 1);
    cleanup();

    lang.hold = null;
    const u = openBoard([panel('p-1', 'Up', 'up')]);
    await screen.findByRole('heading', { level: 3, name: 'Up' });
    act(() => {
      resizeAll(0, 0);
    });
    show('Up');
    await settledLanguage();
    expect(u.range).not.toHaveBeenCalled();
    cleanup();

    const v = openBoard([panel('p-1', 'Up', 'up')]);
    vi.spyOn(v.api, 'promMetadata').mockImplementation(() => new Promise(() => undefined));
    await ready('Up');
    show('Up');
    await calls(v, 1);
  });
});

describe('visible-only queries', () => {
  const four = () => [
    panel('p-1', 'One', 'm1'),
    panel('p-2', 'Two', 'm2'),
    panel('p-3', 'Three', 'm3'),
    panel('p-4', 'Four', 'm4'),
  ];

  it('off-screen panels do not query', async () => {
    const t = openBoard(four());
    await ready('One', 'Two', 'Three', 'Four');
    show('One', 'Two');
    await calls(t, 2);
    expect(reqs(t).map((r) => r.query)).toEqual(['m1', 'm2']);
    show('Three');
    await calls(t, 3);
    expect(reqs(t)[2]?.query).toBe('m3');
    hide('One');
    show('One');
    await flush();
    expect(t.range).toHaveBeenCalledTimes(3);
    expect(observedCount()).toBe(4);
  });

  it('no IntersectionObserver: every panel queries', async () => {
    uninstallIntersectionObserver();
    const t = openBoard(four().slice(0, 3));
    await ready('One', 'Two', 'Three');
    await calls(t, 3);
  });
});

describe('time changes and refresh', () => {
  const memory = () => [
    panel('p-1', 'Mem A', 'node_memory_free_bytes'),
    panel('p-2', 'Mem B', 'node_memory_free_bytes'),
  ];

  it('time change aborts in-flight', async () => {
    const t = openBoard([panel('p-1', 'Requests', 'node_memory_free_bytes')]);
    const h = holdRange(t);
    await ready('Requests');
    show('Requests');
    await calls(t, 1);
    windowKey(']');
    await calls(t, 2);
    expect(h.held[0]?.signal?.aborted).toBe(true);
    expect(h.held[1]?.req.fromMs).toBe(T13);
    await h.held[1]?.resolve(R_B);
    await waitFor(() => {
      expect(seriesValues(t, 'Requests')).toEqual([[10, 20, 30]]);
    });
  });

  it('window change keeps the chart', async () => {
    const t = openBoard([panel('p-1', 'Requests', 'node_memory_free_bytes')]);
    await ready('Requests');
    show('Requests');
    await settled(t, 'Requests');
    const f = frameOf(t, 'Requests');
    if (f === undefined) throw new Error('no frame');
    const frames = t.engine.frames.length;
    const h = holdRange(t);
    windowKey(']');
    await calls(t, 2);
    expect(within(panelOf('Requests')).queryByText('Loading')).toBeNull();
    expect(t.engine.frames).toHaveLength(frames);
    expect(f.disposed).toBe(0);
    await waitFor(
      () => {
        expect(panelOf('Requests').querySelector('[data-shimmer]')).not.toBeNull();
      },
      { timeout: 2_000 },
    );
    await h.held[0]?.resolve();
    expect(f.disposed).toBe(0);
  });

  it('refresh absolute: button', async () => {
    const t = openBoard(memory());
    t.range.mockResolvedValueOnce(R_A).mockResolvedValueOnce(R_A).mockResolvedValue(R_B);
    await ready('Mem A', 'Mem B');
    show('Mem A', 'Mem B');
    await calls(t, 2);
    for (const title of ['Mem A', 'Mem B']) {
      await waitFor(() => {
        expect(seriesValues(t, title)).toEqual([[1, 2, 3]]);
      });
    }
    const key = (lastData(t, 'Mem A') as Extract<FrameData, { kind: 'series' }>).series[0]?.key;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh now' }));
    await calls(t, 4);
    const [a, b, c, d] = reqs(t);
    for (const r of [c, d]) {
      expect(r?.query).toBe(a?.query);
      expect([r?.fromMs, r?.toMs]).toEqual([a?.fromMs, a?.toMs]);
    }
    expect([b?.fromMs, b?.toMs]).toEqual([T12, T13]);
    for (const title of ['Mem A', 'Mem B']) {
      await waitFor(() => {
        expect(seriesValues(t, title)).toEqual([[10, 20, 30]]);
      });
      const s = lastData(t, title) as Extract<FrameData, { kind: 'series' }>;
      expect(s.series[0]?.key).toBe(key);
    }
  });

  it('refresh absolute: interval', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const t = openBoard(memory(), { search: ABS.replace('refresh=off', 'refresh=10s') });
    t.range.mockResolvedValueOnce(R_A).mockResolvedValueOnce(R_A).mockResolvedValue(R_B);
    await ready('Mem A', 'Mem B');
    show('Mem A', 'Mem B');
    await calls(t, 2);
    await waitFor(() => {
      expect(seriesValues(t, 'Mem B')).toEqual([[1, 2, 3]]);
    });
    act(() => {
      vi.advanceTimersByTime(9_999);
    });
    await flush();
    expect(t.range).toHaveBeenCalledTimes(2);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    await calls(t, 4);
    for (const title of ['Mem A', 'Mem B']) {
      await waitFor(() => {
        expect(seriesValues(t, title)).toEqual([[10, 20, 30]]);
      });
    }
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    await flush();
    expect(t.range).toHaveBeenCalledTimes(4);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => {
      await t.router.navigate(`/t/demo/board/b-1?${ABS}`, { replace: true });
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    await flush();
    expect(t.range).toHaveBeenCalledTimes(4);
  });

  it('refresh relative: button', async () => {
    let now = T;
    const t = openBoard(memory(), { search: REL, now: () => now });
    await ready('Mem A', 'Mem B');
    show('Mem A', 'Mem B');
    await calls(t, 2);
    await settled(t, 'Mem B');
    const before = reqs(t)[0]?.fromMs ?? 0;
    now += 1_000;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh now' }));
    await calls(t, 4);
    await flush();
    expect(t.range).toHaveBeenCalledTimes(4);
    expect(
      reqs(t)
        .slice(2)
        .map((r) => r.fromMs),
    ).toEqual([before + 1_000, before + 1_000]);
    expect(signals(t).map((s) => s?.aborted ?? false)).toEqual([false, false, false, false]);
  });

  it('refresh relative: interval', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let now = T;
    const t = openBoard(memory(), {
      search: REL.replace('refresh=off', 'refresh=10s'),
      now: () => now,
    });
    await ready('Mem A', 'Mem B');
    show('Mem A', 'Mem B');
    await calls(t, 2);
    await settled(t, 'Mem B');
    const start = reqs(t)[0]?.fromMs ?? 0;
    for (let k = 1; k <= 2; k++) {
      now += 10_000;
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      await calls(t, 2 + 2 * k);
      await flush();
      expect(t.range).toHaveBeenCalledTimes(2 + 2 * k);
      expect(
        reqs(t)
          .slice(-2)
          .map((r) => r.fromMs),
      ).toEqual([start + k * 10_000, start + k * 10_000]);
      await settled(t, 'Mem B');
    }
    expect(signals(t).some((s) => s?.aborted === true)).toBe(false);
  });

  it.each([
    ['ABS', 'button'],
    ['ABS', 'interval'],
    ['REL', 'button'],
    ['REL', 'interval'],
  ] as const)('refresh during the first load: %s, %s', async (win, how) => {
    if (how === 'interval') vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let now = T;
    const base = win === 'ABS' ? ABS : REL;
    const search = how === 'interval' ? base.replace('refresh=off', 'refresh=10s') : base;
    const t = openBoard([panel('p-1', 'Requests', 'node_memory_free_bytes')], {
      search,
      now: () => now,
    });
    const h = holdRange(t);
    await ready('Requests');
    show('Requests');
    await calls(t, 1);
    now += 1_000;
    if (how === 'button') fireEvent.click(screen.getByRole('button', { name: 'Refresh now' }));
    else {
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
    }
    await calls(t, 2);
    await flush();
    expect(t.range).toHaveBeenCalledTimes(2);
    expect(h.held[0]?.signal?.aborted).toBe(true);
    const [a, b] = reqs(t);
    const shift = win === 'ABS' ? 0 : 1_000;
    expect(b?.fromMs).toBe((a?.fromMs ?? 0) + shift);
    expect(b?.toMs).toBe((a?.toMs ?? 0) + shift);
    await h.held[1]?.resolve(R_B);
    await waitFor(() => {
      expect(seriesValues(t, 'Requests')).toEqual([[10, 20, 30]]);
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each(['keys', 'history'] as const)('time change A → B → A re-queries: %s', async (how) => {
    const t = openBoard(memory());
    await ready('Mem A', 'Mem B');
    show('Mem A', 'Mem B');
    await calls(t, 2);
    await settled(t, 'Mem A');
    await settled(t, 'Mem B');
    windowKey(']');
    await calls(t, 4);
    await settled(t, 'Mem A');
    await settled(t, 'Mem B');
    await waitFor(() => {
      expect(panelOf('Mem B').querySelector('[data-shimmer]')).toBeNull();
    });
    const frames = t.engine.frames.length;
    const h = holdRange(t);
    if (how === 'keys') windowKey('[');
    else {
      await act(async () => {
        await t.router.navigate(-1);
      });
    }
    await calls(t, 6);
    expect(
      reqs(t)
        .slice(4)
        .map((r) => [r.fromMs, r.toMs]),
    ).toEqual([
      [T12, T13],
      [T12, T13],
    ]);
    expect(within(panelOf('Mem A')).queryByText('Loading')).toBeNull();
    expect(t.engine.frames).toHaveLength(frames);
    expect(signals(t).some((s) => s?.aborted === true)).toBe(false);
    for (const x of h.held) await x.resolve();
  });

  it('hidden panel on a cached window', async () => {
    const t = openBoard(memory());
    await ready('Mem A', 'Mem B');
    show('Mem A', 'Mem B');
    await calls(t, 2);
    await settled(t, 'Mem B');
    hide('Mem B');
    windowKey(']');
    await calls(t, 3);
    await settled(t, 'Mem A');
    windowKey('[');
    await calls(t, 4);
    await flush();
    show('Mem B');
    await calls(t, 5);
    expect([reqs(t)[4]?.fromMs, reqs(t)[4]?.toMs]).toEqual([T12, T13]);
    await settled(t, 'Mem B');
    hide('Mem B');
    show('Mem B');
    await flush();
    expect(t.range).toHaveBeenCalledTimes(5);
  });

  it.each(['ABS', 'REL'] as const)('no extra request within an epoch: %s', async (win) => {
    let now = T;
    const t = openBoard([panel('p-1', 'Requests', 'node_memory_free_bytes')], {
      search: win === 'ABS' ? ABS : REL,
      now: () => now,
    });
    await ready('Requests');
    show('Requests');
    await calls(t, 1);
    await settled(t, 'Requests');
    now += 1_000;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh now' }));
    await calls(t, 2);
    await flush();
    hide('Requests');
    show('Requests');
    await flush();
    expect(t.range).toHaveBeenCalledTimes(2);
    windowKey(']');
    await calls(t, 3);
    await flush();
    hide('Requests');
    show('Requests');
    await flush();
    expect(t.range).toHaveBeenCalledTimes(3);
  });

  it('reopening a board re-queries', async () => {
    const t = openBoard(memory());
    await ready('Mem A', 'Mem B');
    show('Mem A', 'Mem B');
    await calls(t, 2);
    await settled(t, 'Mem B');
    await act(async () => {
      await t.router.navigate(`/t/demo/boards?${ABS}`);
    });
    await screen.findByRole('heading', { level: 1, name: 'Boards' });
    await act(async () => {
      await t.router.navigate(`/t/demo/board/b-1?${ABS}`);
    });
    await ready('Mem A', 'Mem B');
    show('Mem A', 'Mem B');
    await calls(t, 4);
    expect(
      reqs(t)
        .slice(2)
        .map((r) => [r.fromMs, r.toMs]),
    ).toEqual([
      [T12, T13],
      [T12, T13],
    ]);
  });

  it('refresh reaches off-screen panels later', async () => {
    const t = openBoard(memory());
    await ready('Mem A', 'Mem B');
    show('Mem A', 'Mem B');
    await calls(t, 2);
    await settled(t, 'Mem B');
    hide('Mem B');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh now' }));
    await calls(t, 3);
    await flush();
    expect(t.range).toHaveBeenCalledTimes(3);
    show('Mem B');
    await calls(t, 4);
    await settled(t, 'Mem B');
    hide('Mem B');
    show('Mem B');
    await flush();
    expect(t.range).toHaveBeenCalledTimes(4);
  });

  it('shimmer after 300 ms', async () => {
    const t = openBoard([panel('p-1', 'Requests', 'node_memory_free_bytes')]);
    await ready('Requests');
    show('Requests');
    await settled(t, 'Requests');
    const h = holdRange(t);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await act(async () => {
      windowKey(']');
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(h.held).toHaveLength(1);
    const shimmer = () => panelOf('Requests').querySelector('[data-shimmer]');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(299);
    });
    expect(shimmer()).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(shimmer()).not.toBeNull();
    expect(panelOf('Requests').querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(panelOf('Requests').querySelector('[role="progressbar"]')).toBeNull();
    await act(async () => {
      await h.held[0]?.resolve(R_B);
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(shimmer()).toBeNull();
  });
});
