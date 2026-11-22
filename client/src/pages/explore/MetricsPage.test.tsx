import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StubApi } from '../../api/StubApi';
import { STUB_PROM_METRIC_NAMES } from '../../api/stubData';
import { ApiError } from '../../api/types';
import type { InstantResult, PromMetadata, RangeResult } from '../../data/decode';
import { seriesName } from '../../data/frames';
import { queryBytes } from '../../explore/querySize';
import {
  ABS,
  alertText,
  bodyRows,
  cell,
  drawn,
  EMPTY_COMPLETENESS,
  flush,
  HOLD,
  HOUR,
  lastData,
  lastSpec,
  openExplore,
  P1,
  P2,
  P3,
  plannedAs,
  range,
  ready,
  runButton,
  runKey,
  S1,
  S2,
  S3,
  setDraft,
  sized,
  spyInstant,
  spyRange,
  textbox,
  url,
  W0,
  windowKey,
} from '../../test/exploreTestKit';
import { fakeEditorSource } from '../../test/fakeEditor';
import { F } from '../../test/fakePromSource';
import { installResizeObserver, resizeAll } from '../../test/fakeResizeObserver';
import { G2, H1 } from '../../test/histogramFixtures';
import { locationOf } from '../../test/renderApp';
import { fromRange } from '../../vis/autovis';
import { framePlan } from '../../vis/framePlan';

vi.mock('../../editor/editor', () => import('../../test/fakeEditor'));

beforeEach(() => {
  installResizeObserver();
  fakeEditorSource.data = F;
});

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});

const QUERY_TOO_LARGE =
  'This query is over 128 KB. Completion is paused, and it cannot be run until it is shorter.';
const TOO_LONG =
  'The query to send, with any rate applied, is over 64 KiB, the most the server accepts. Shorten it.';
const WAITING = 'Run is available once the chart has a size.';
/** `prom.WarnTypesUnavailable`, the server's text (only StubApi may import the mirror). */
const WARN_TYPES_UNAVAILABLE =
  'pulsus-dash: metric types unavailable, so only names ending in _total are rated (metric_types_unavailable)';
const NARROW = 'Narrow the time range';

/** A promise the test settles. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('MetricsPage runs', () => {
  it('MetricsPage run on load', async () => {
    const api = new StubApi();
    const spy = vi.spyOn(api, 'queryRange');
    openExplore(url('http_requests_total'), { api });
    await ready();
    await waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(1);
    });
    const req = spy.mock.calls[0]?.[1];
    expect(req).toMatchObject({ query: 'http_requests_total', rate: true, widthPx: 1000 });
    expect(await screen.findByRole('radio', { name: 'Auto (Line)' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Rate applied' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByText('Sent query: rate(http_requests_total[1m])')).toBeInTheDocument();
  });

  it('MetricsPage does not wait for metadata', async () => {
    const api = new StubApi();
    vi.spyOn(api, 'promMetadata').mockReturnValue(new Promise<PromMetadata>(() => undefined));
    const spy = vi.spyOn(api, 'queryRange');
    openExplore(url('http_requests_total'), { api });
    await ready();
    await waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(1);
    });
    expect(spy.mock.calls[0]?.[1].query).toBe('http_requests_total');
    await flush();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('MetricsPage scalar', async () => {
    const api = new StubApi();
    const scalar: InstantResult = {
      kind: 'scalar',
      scalar: { value: Infinity, timestampMs: W0 + HOUR },
      atMs: W0 + HOUR,
      completeness: EMPTY_COMPLETENESS,
      planned: plannedAs('scalar(vector(1)) / 0', { valueType: 'scalar' }, null),
    };
    const inst = spyInstant(api, [scalar]);
    const rng = spyRange(api, [S1]);
    openExplore(url('scalar(vector(1)) / 0'), { api });
    await ready();
    await waitFor(() => {
      expect(inst).toHaveLength(1);
    });
    expect(inst[0]?.req).toEqual({ query: 'scalar(vector(1)) / 0', atMs: W0 + HOUR, stepMs: 5000 });
    expect(rng).toHaveLength(0);
    expect(await screen.findByRole('radio', { name: 'Auto (Stat)' })).toBeChecked();
  });

  it('MetricsPage histogram', async () => {
    const api = new StubApi();
    const q = 'sum by (le) (rate(http_request_duration_seconds_bucket[5m]))';
    spyRange(api, [range(H1(), EMPTY_COMPLETENESS, plannedAs(q, { histogram: true }))]);
    const { engine } = openExplore(url(q), { api });
    await ready();
    expect(await screen.findByRole('radio', { name: 'Auto (Heatmap)' })).toBeChecked();
    await waitFor(() => {
      expect(lastSpec(engine)?.kind).toBe('heatmap');
    });
    expect(bodyRows()).toHaveLength(3);
    expect(document.querySelectorAll('[data-swatch]')).toHaveLength(0);
  });

  it('MetricsPage string result', async () => {
    for (const extra of ['', '&vis=line']) {
      const api = new StubApi();
      const str: InstantResult = {
        kind: 'string',
        value: 'hello',
        timestampMs: W0 + HOUR,
        atMs: W0 + HOUR,
        completeness: EMPTY_COMPLETENESS,
        planned: plannedAs('"hello"', { valueType: 'string' }, null),
      };
      const inst = spyInstant(api, [str]);
      const rng = spyRange(api, [S1]);
      openExplore(url('"hello"', extra), { api });
      await ready();
      expect(await screen.findByText('String result: hello')).toBeInTheDocument();
      expect(inst).toHaveLength(1);
      expect(rng).toHaveLength(0);
      expect(document.querySelector('[data-chart-frame]')).toBeNull();
      expect(screen.queryByRole('table')).toBeNull();
      expect(screen.getByText(/^String · \d+ (ms|s)$/)).toBeInTheDocument();
      const checked = extra === '' ? 'Auto' : 'Line';
      expect(screen.getByRole('radio', { name: checked })).toBeChecked();
      cleanup();
    }
  });
});

describe('MetricsPage time and refresh', () => {
  it('MetricsPage supersede', async () => {
    const api = new StubApi();
    const rng = spyRange(api, [HOLD, S2]);
    const { engine } = openExplore(url('up'), { api });
    await ready();
    await waitFor(() => {
      expect(rng).toHaveLength(1);
    });
    windowKey('BracketRight');
    await waitFor(() => {
      expect(rng).toHaveLength(2);
    });
    expect(rng[0]?.signal?.aborted).toBe(true);
    expect(rng[1]?.req.fromMs).toBe(W0 + HOUR);
    expect(rng[1]?.req.toMs).toBe(W0 + 2 * HOUR);
    await waitFor(() => {
      expect(drawn(engine)).toEqual([{ key: S2.series[0]?.key, values: [3, 4] }]);
    });
  });

  it('MetricsPage frame kept across a window change', async () => {
    const api = new StubApi();
    const rng = spyRange(api, [S1, S2]);
    const { engine } = openExplore(url('up'), { api });
    await ready();
    await waitFor(() => {
      expect(drawn(engine)).toEqual([{ key: S1.series[0]?.key, values: [1, 2] }]);
    });
    windowKey('BracketRight');
    await waitFor(() => {
      expect(rng).toHaveLength(2);
    });
    await waitFor(() => {
      expect(drawn(engine)).toEqual([{ key: S2.series[0]?.key, values: [3, 4] }]);
    });
    expect(engine.frames).toHaveLength(1);
    expect(engine.frames[0]?.disposed).toBe(0);
  });

  it('MetricsPage refresh', async () => {
    const api = new StubApi();
    const rng = spyRange(api, [S1, S2]);
    const { user } = openExplore(url('up'), { api });
    await ready();
    await waitFor(() => {
      expect(cell(0, 1)).toBe('2');
    });
    await user.click(screen.getByRole('button', { name: 'Refresh now' }));
    await waitFor(() => {
      expect(rng).toHaveLength(2);
    });
    expect(rng[1]?.req).toEqual(rng[0]?.req);
    await waitFor(() => {
      expect(cell(0, 1)).toBe('4');
    });
  });

  it('MetricsPage interval refresh', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const api = new StubApi();
    const rng = spyRange(api, [S1, S2, S3]);
    const abs = ABS.replace('refresh=off', 'refresh=10s');
    const { router } = openExplore(url('up', '', 'demo', abs), { api });
    await ready();
    await waitFor(() => {
      expect(cell(0, 1)).toBe('2');
    });
    act(() => {
      vi.advanceTimersByTime(9_999);
    });
    await flush();
    expect(rng).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    await waitFor(() => {
      expect(rng).toHaveLength(2);
    });
    expect(rng[1]?.req).toEqual(rng[0]?.req);
    await waitFor(() => {
      expect(cell(0, 1)).toBe('4');
    });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    await flush();
    expect(rng).toHaveLength(2);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => {
      await router.navigate(url('up'), { replace: true });
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    await flush();
    expect(rng).toHaveLength(2);
  });

  it('MetricsPage refresh during the first fetch', async () => {
    for (const how of ['button', 'interval'] as const) {
      if (how === 'interval') vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const api = new StubApi();
      const rng = spyRange(api, [HOLD, S1]);
      const u =
        how === 'button'
          ? url('up')
          : url('up', '', 'demo', ABS.replace('refresh=off', 'refresh=10s'));
      const { router } = openExplore(u, { api });
      await ready();
      await waitFor(() => {
        expect(rng).toHaveLength(1);
      });
      const before = locationOf(router);
      if (how === 'button') fireEvent.click(screen.getByRole('button', { name: 'Refresh now' }));
      else {
        act(() => {
          vi.advanceTimersByTime(10_000);
        });
      }
      await waitFor(() => {
        expect(rng).toHaveLength(2);
      });
      expect(rng[0]?.signal?.aborted).toBe(true);
      expect(rng[1]?.signal?.aborted).toBe(false);
      expect(rng[1]?.req).toEqual(rng[0]?.req);
      await waitFor(() => {
        expect(cell(0, 1)).toBe('2');
      });
      expect(screen.queryByRole('alert')).toBeNull();
      expect(locationOf(router)).toBe(before);
      cleanup();
      vi.useRealTimers();
    }
  });

  it('MetricsPage shimmer', async () => {
    const api = new StubApi();
    const rng = spyRange(api, [HOLD]);
    openExplore(url('up'), { api });
    await screen.findByRole('heading', { level: 2, name: 'Result' });
    await screen.findByRole('textbox', { name: 'PromQL query' });
    await flush();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    act(() => {
      resizeAll(1000, 240);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(rng).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(298);
    });
    expect(document.querySelector('[data-shimmer]')).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2);
    });
    expect(document.querySelector('[data-shimmer]')).not.toBeNull();
    await act(async () => {
      rng[0]?.release(S1);
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(document.querySelector('[data-shimmer]')).toBeNull();
  });
});

describe('MetricsPage errors and notices', () => {
  it('MetricsPage errors', async () => {
    const api = new StubApi();
    const rng = spyRange(api, [
      S1,
      new ApiError('queryInvalid', 'bad', { detail: { position: 3 } }),
      new ApiError('tooBroad', 'too broad'),
      new ApiError('timeout', 'slow'),
    ]);
    const { engine, router } = openExplore(url('up'), { api });
    await ready();
    await waitFor(() => {
      expect(drawn(engine)).toEqual([{ key: S1.series[0]?.key, values: [1, 2] }]);
    });
    setDraft('up{');
    runKey();
    await waitFor(() => {
      expect(alertText()).toBe('bad');
    });
    expect(rng[1]?.req.query).toBe('up{');
    expect(JSON.parse(textbox().getAttribute('data-diagnostics') ?? '')).toEqual([
      { from: 2, to: 3, message: 'bad', positionKnown: true },
    ]);
    expect(drawn(engine)).toEqual([{ key: S1.series[0]?.key, values: [1, 2] }]);

    runKey();
    await waitFor(() => {
      expect(alertText()).toContain('too broad');
    });
    expect(within(screen.getByRole('alert')).getByRole('button', { name: NARROW })).toBeVisible();
    runKey();
    await waitFor(() => {
      expect(alertText()).toContain('The query timed out.');
    });
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: NARROW }));
    await waitFor(() => {
      expect(router.state.location.search).toContain('from=2026-11-19T12%3A15%3A00.000Z');
    });
    expect(router.state.location.search).toContain('to=2026-11-19T12%3A45%3A00.000Z');
    expect(drawn(engine)).toEqual([{ key: S1.series[0]?.key, values: [1, 2] }]);
  });

  it('MetricsPage partial data', async () => {
    const api = new StubApi();
    const completeness = {
      ...EMPTY_COMPLETENESS,
      truncated: true,
      warnings: ['results truncated due to limit'],
    };
    spyRange(api, [range(S1.series, completeness)]);
    openExplore(url('up'), { api });
    await ready();
    const box = await screen.findByRole('status', { name: 'Query notices' });
    expect(box).toHaveTextContent('Partial data');
    expect(box).toHaveTextContent('results truncated due to limit');
    expect(within(box).getByRole('button', { name: NARROW })).toBeVisible();
  });

  it('MetricsPage warnings only', async () => {
    const api = new StubApi();
    const completeness = {
      ...EMPTY_COMPLETENESS,
      warnings: ['vector selector matched an expired series'],
    };
    spyRange(api, [range(S1.series, completeness)]);
    const { engine } = openExplore(url('up'), { api });
    await ready();
    const box = await screen.findByRole('status', { name: 'Query notices' });
    expect(box.querySelector('[data-badge="warnings"]')).toHaveTextContent('Warnings');
    const list = within(box).getByRole('list', { name: 'Warnings' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['vector selector matched an expired series']);
    expect(within(box).queryByText('Partial data')).toBeNull();
    expect(screen.queryByRole('button', { name: NARROW })).toBeNull();
    await waitFor(() => {
      expect(drawn(engine)).toEqual([{ key: S1.series[0]?.key, values: [1, 2] }]);
    });
  });
});

describe('MetricsPage keys and controls', () => {
  it('MetricsPage rerun during the first fetch', async () => {
    const api = new StubApi();
    const rng = spyRange(api, [HOLD, S1]);
    const { router } = openExplore(url('up'), { api });
    await ready();
    await waitFor(() => {
      expect(rng).toHaveLength(1);
    });
    const before = locationOf(router);
    const action = router.state.historyAction;
    runKey();
    await waitFor(() => {
      expect(rng).toHaveLength(2);
    });
    expect(rng[0]?.signal?.aborted).toBe(true);
    expect(rng[1]?.signal?.aborted).toBe(false);
    expect(rng[1]?.req).toEqual(rng[0]?.req);
    await waitFor(() => {
      expect(cell(0, 1)).toBe('2');
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(locationOf(router)).toBe(before);
    expect(router.state.historyAction).toBe(action);
  });

  it('MetricsPage rerun during a refetch', async () => {
    const api = new StubApi();
    const rng = spyRange(api, [S1, HOLD, S2]);
    openExplore(url('up'), { api });
    await ready();
    await waitFor(() => {
      expect(cell(0, 1)).toBe('2');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh now' }));
    await waitFor(() => {
      expect(rng).toHaveLength(2);
    });
    runKey();
    await waitFor(() => {
      expect(rng).toHaveLength(3);
    });
    expect(rng[1]?.signal?.aborted).toBe(true);
    await waitFor(() => {
      expect(cell(0, 1)).toBe('4');
    });
  });

  it('MetricsPage rate and vis', async () => {
    const api = new StubApi();
    const spy = vi.spyOn(api, 'queryRange');
    const { router, engine, user } = openExplore(url('http_requests_total'), { api });
    await ready();
    await waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(1);
    });
    await user.click(await screen.findByRole('button', { name: 'Rate applied' }));
    await waitFor(() => {
      expect(router.state.location.search).toContain('rate=off');
    });
    expect(router.state.historyAction).toBe('REPLACE');
    await waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(2);
    });
    expect(spy.mock.calls[1]?.[1]).toMatchObject({ query: 'http_requests_total', rate: false });
    expect(spy.mock.calls[0]?.[1]).toMatchObject({ query: 'http_requests_total', rate: true });
    await waitFor(() => {
      expect(engine.frames.length).toBeGreaterThan(0);
    });
    await user.click(screen.getByRole('radio', { name: 'Bars' }));
    await waitFor(() => {
      expect(router.state.location.search).toContain('vis=bars');
    });
    await waitFor(() => {
      expect(lastSpec(engine)?.kind).toBe('bars');
    });
    await flush();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('MetricsPage run keys', async () => {
    const api = new StubApi();
    const rng = spyRange(api, [S1]);
    const { router } = openExplore(url(), { api });
    await ready();
    setDraft('up');
    runKey();
    await waitFor(() => {
      expect(router.state.location.search).toContain('q=up');
    });
    expect(router.state.historyAction).toBe('PUSH');
    await waitFor(() => {
      expect(rng).toHaveLength(1);
    });
    const at = locationOf(router);
    runKey();
    await waitFor(() => {
      expect(rng).toHaveLength(2);
    });
    expect(locationOf(router)).toBe(at);
    runKey({ ctrlKey: true });
    await waitFor(() => {
      expect(rng).toHaveLength(3);
    });
  });

  it('MetricsPage escape', async () => {
    openExplore(url('up'));
    const run = await ready();
    const box = await screen.findByRole('textbox', { name: 'PromQL query' });
    box.focus();
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(run).toHaveFocus();
  });

  it('MetricsPage picker inserts', async () => {
    fakeEditorSource.data = { ...F, names: STUB_PROM_METRIC_NAMES };
    const { user } = openExplore(url());
    await ready();
    const picker = screen.getByRole('combobox', { name: 'Metric' });
    await waitFor(() => {
      expect(picker).toBeEnabled();
    });
    await user.click(picker);
    await screen.findByRole('listbox');
    await user.keyboard('memory');
    await screen.findByRole('option', { name: /^node_memory_free_bytes/ });
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(textbox().value).toBe('node_memory_free_bytes');
    });
    expect(textbox()).toHaveFocus();
    expect(picker).toHaveValue('');
  });
});

describe('MetricsPage state across views', () => {
  it('MetricsPage away and back', async () => {
    for (const variant of ['window', 'refetch'] as const) {
      const api = new StubApi();
      const steps =
        variant === 'window'
          ? [S1, S2, new ApiError('unavailable', 'down')]
          : [S1, new ApiError('unavailable', 'down')];
      const rng = spyRange(api, steps);
      const { router, engine, user } = openExplore(url('up'), { api });
      await ready();
      await waitFor(() => {
        expect(cell(0, 1)).toBe('2');
      });
      await act(async () => {
        // The canonical search (encoded), so the loader does not turn the push into a replace.
        await router.navigate(`/t/demo/boards?${ABS.replaceAll(':', '%3A')}`);
      });
      await screen.findByRole('heading', { level: 1, name: 'Boards' });
      await act(async () => {
        await router.navigate(-1);
      });
      // A new chart host: a browser's ResizeObserver reports its first size on observe.
      await sized();
      await waitFor(() => {
        expect(cell(0, 1)).toBe('2');
      });
      expect(rng).toHaveLength(1);
      if (variant === 'window') {
        windowKey('BracketRight');
        await waitFor(() => {
          expect(cell(0, 1)).toBe('4');
        });
        windowKey('BracketRight');
        await waitFor(() => {
          expect(alertText()).toContain('PulsusDB is unavailable');
        });
        expect(cell(0, 1)).toBe('4');
        expect(drawn(engine)).toEqual([{ key: S2.series[0]?.key, values: [3, 4] }]);
      } else {
        await user.click(screen.getByRole('button', { name: 'Refresh now' }));
        await waitFor(() => {
          expect(alertText()).toContain('PulsusDB is unavailable');
        });
        expect(cell(0, 1)).toBe('2');
        expect(drawn(engine)).toEqual([{ key: S1.series[0]?.key, values: [1, 2] }]);
      }
      cleanup();
    }
  });

  it('MetricsPage empty query hides the result', async () => {
    const api = new StubApi();
    const rng = spyRange(api, [S1, HOLD]);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
    const { router } = openExplore(url('up'), { api, queryClient });
    await ready();
    await waitFor(() => {
      expect(bodyRows()).toHaveLength(1);
    });
    expect(document.querySelector('[data-chart-frame]')).not.toBeNull();
    setDraft('');
    fireEvent.click(runButton());
    await waitFor(() => {
      expect(router.state.location.search).not.toContain('q=');
    });
    expect(router.state.historyAction).toBe('PUSH');
    expect(await screen.findByText('Run a query to see a chart')).toBeInTheDocument();
    expect(document.querySelector('[data-chart-frame]')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: 'Visualisation' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rate applied' })).toBeNull();
    expect(screen.queryByText(/^1 series/)).toBeNull();
    expect(rng).toHaveLength(1);
    await act(async () => {
      await router.navigate(-1);
    });
    await waitFor(() => {
      expect(bodyRows()).toHaveLength(1);
    });
    expect(document.querySelector('[data-chart-frame]')).not.toBeNull();
    await waitFor(() => {
      expect(rng).toHaveLength(2);
    });
    expect(bodyRows()).toHaveLength(1);
  });

  it('MetricsPage isolation kept across new results', async () => {
    const api = new StubApi();
    const rng = spyRange(api, [P1, P2, P2, P3]);
    const { engine, user } = openExplore(url('up'), { api });
    await ready();
    const rowA = await screen.findByRole('button', { name: 'up{job="a"}' });
    await user.click(rowA);
    await waitFor(() => {
      expect(drawn(engine)).toEqual([{ key: P1.series[0]?.key, values: [1, 2] }]);
    });
    windowKey('BracketRight');
    await waitFor(() => {
      expect(drawn(engine)).toEqual([{ key: P1.series[0]?.key, values: [3, 4] }]);
    });
    expect(rng).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'up{job="a"}' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const rowB = screen.getByRole('button', { name: 'up{job="b"}' }).closest('tr');
    expect(rowB).toHaveAttribute('data-dimmed');
    await user.click(screen.getByRole('button', { name: 'Refresh now' }));
    await waitFor(() => {
      expect(rng).toHaveLength(3);
    });
    await flush();
    expect(drawn(engine)).toEqual([{ key: P1.series[0]?.key, values: [3, 4] }]);
    windowKey('BracketRight');
    await waitFor(() => {
      expect(drawn(engine)).toEqual([{ key: P3.series[0]?.key, values: [7, 8] }]);
    });
    expect(screen.queryByRole('button', { pressed: true, name: /^up/ })).toBeNull();
    expect(document.querySelector('tr[data-dimmed]')).toBeNull();
  });

  it('MetricsPage tenant switch', async () => {
    const api = new StubApi();
    const rng = vi.spyOn(api, 'queryRange').mockImplementation((tenant, _req, signal) =>
      tenant === 'demo'
        ? Promise.resolve(S1)
        : new Promise((_res, rej) => {
            signal?.addEventListener('abort', () => {
              rej(new DOMException('aborted', 'AbortError'));
            });
          }),
    );
    const { router } = openExplore(url('up'), { api });
    await ready();
    await waitFor(() => {
      expect(bodyRows()).toHaveLength(1);
    });
    await act(async () => {
      await router.navigate(url('up', '', 'sandbox'));
    });
    await waitFor(() => {
      expect(rng.mock.calls.some((c) => c[0] === 'sandbox')).toBe(true);
    });
    expect(document.querySelector('[data-chart-frame]')).toBeNull();
    expect(bodyRows()).toHaveLength(0);
  });

  it('MetricsPage heatmap row isolation', async () => {
    const api = new StubApi();
    const g2 = range(G2());
    spyRange(api, [g2]);
    const { engine, user } = openExplore(url('x', '&vis=heatmap'), { api });
    await ready();
    await waitFor(() => {
      expect(bodyRows()).toHaveLength(6);
    });
    for (const r of bodyRows()) expect(within(r).getByRole('button')).toBeInTheDocument();
    const target = G2()[1];
    if (target === undefined) throw new Error('no G2 row');
    const button = screen.getByRole('button', { name: seriesName(target.labels) });
    await user.click(button);
    const isolated = framePlan('heatmap', fromRange(g2), {
      isolatedKey: target.key,
      title: 'Query result',
      rateApplied: false,
    }).data;
    await waitFor(() => {
      expect(lastData(engine)).toEqual(isolated);
    });
    expect(button).toHaveAttribute('aria-pressed', 'true');
    await user.click(button);
    const full = framePlan('heatmap', fromRange(g2), {
      isolatedKey: null,
      title: 'Query result',
      rateApplied: false,
    }).data;
    await waitFor(() => {
      expect(lastData(engine)).toEqual(full);
    });
    expect(button).toHaveAttribute('aria-pressed', 'false');
    await user.click(screen.getByRole('radio', { name: 'Line' }));
    await user.click(screen.getByRole('button', { name: seriesName(target.labels) }));
    await waitFor(() => {
      expect(drawn(engine)).toHaveLength(1);
    });
    await user.click(screen.getByRole('button', { name: seriesName(target.labels) }));
    await waitFor(() => {
      expect(drawn(engine)).toHaveLength(6);
    });
  });
});

/** `docOf(n)` is `n` UTF-8 bytes (Part B). */
const docOf = (n: number): string => '#' + 'a'.repeat(n - 10) + '\nup{job="';
const R4 = 'x_total{a="' + 'b'.repeat(65_514) + '"}';

type Spies = ReturnType<typeof spyBoth>;

function spyBoth(api: StubApi) {
  return { range: vi.spyOn(api, 'queryRange'), instant: vi.spyOn(api, 'queryInstant') };
}

function noCall(s: Spies): void {
  expect(s.range).not.toHaveBeenCalled();
  expect(s.instant).not.toHaveBeenCalled();
}

describe('unit:explore-run-size', () => {
  it('R1 a URL query over 128 KB', async () => {
    const api = new StubApi();
    const spies = spyBoth(api);
    const { user } = openExplore(url(docOf(131_073)), { api });
    const run = await ready();
    await waitFor(() => {
      expect(alertText()).toBe(QUERY_TOO_LARGE);
    });
    await flush();
    noCall(spies);
    await user.click(run);
    runKey();
    runKey({ ctrlKey: true });
    await flush();
    noCall(spies);
    expect(alertText()).toBe(QUERY_TOO_LARGE);
  });

  it('R1b a draft over 128 KB', async () => {
    const api = new StubApi();
    const spies = spyBoth(api);
    const { router } = openExplore(url(), { api });
    const run = await ready();
    setDraft(docOf(131_073));
    expect(screen.getByText(QUERY_TOO_LARGE).closest('[role]')).toHaveAttribute('role', 'status');
    fireEvent.click(run);
    await waitFor(() => {
      expect(alertText()).toBe(QUERY_TOO_LARGE);
    });
    await flush();
    noCall(spies);
    expect(router.state.location.search).not.toContain('q=');
  });

  it('R2 a draft of exactly 128 KB', async () => {
    const api = new StubApi();
    const spies = spyBoth(api);
    const { router } = openExplore(url(), { api });
    const run = await ready();
    setDraft(docOf(131_072));
    expect(screen.queryByText(QUERY_TOO_LARGE)).toBeNull();
    fireEvent.click(run);
    await waitFor(() => {
      expect(alertText()).toBe(TOO_LONG);
    });
    await flush();
    expect(spies.range).toHaveBeenCalledTimes(1);
    expect(spies.range.mock.calls[0]?.[1].query).toBe(docOf(131_072));
    expect(router.state.location.search).toContain('q=');
  });

  it('R3 the rewrite fits at 64 KiB', async () => {
    const api = new StubApi();
    const spy = vi.spyOn(api, 'queryRange');
    openExplore(url(), { api });
    await ready();
    const raw = 'x_total{a="' + 'b'.repeat(65_513) + '"}';
    setDraft(raw);
    runKey();
    await waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(1);
    });
    expect(spy.mock.calls[0]?.[1].query).toBe(raw);
    expect(queryBytes(raw)).toBe(65_526);
    const result = (await spy.mock.results[0]?.value) as RangeResult | undefined;
    const planned = result?.planned;
    expect(planned?.bytes).toBe(65_536);
    expect(planned?.query.startsWith('rate(x_total{a="')).toBe(true);
    expect(planned?.query.endsWith('"}[1m])')).toBe(true);
    await flush();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('R4 the rewrite expansion is counted', async () => {
    const api = new StubApi();
    const spies = spyBoth(api);
    const { router } = openExplore(url(), { api });
    await ready();
    setDraft(R4);
    runKey();
    await waitFor(() => {
      expect(alertText()).toBe(TOO_LONG);
    });
    await flush();
    expect(spies.range).toHaveBeenCalledTimes(1);
    expect(spies.range.mock.calls[0]?.[1].query).toBe(R4);
    // The server refuses the planned text: QC1 now holds only for the 128 KB pre-check.
    expect(router.state.location.search).toContain('q=');
  });

  it('R5 no rewrite with rate=off', async () => {
    const api = new StubApi();
    const spy = vi.spyOn(api, 'queryRange');
    openExplore(url(undefined, '&rate=off'), { api });
    await ready();
    setDraft(R4);
    runKey();
    await waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(1);
    });
    expect(spy.mock.calls[0]?.[1]).toMatchObject({ query: R4, rate: false });
    await flush();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('R6 the size status clears when the draft shrinks', async () => {
    const api = new StubApi();
    const spies = spyBoth(api);
    openExplore(url(), { api });
    await ready();
    setDraft(docOf(131_073));
    expect(screen.getByText(QUERY_TOO_LARGE)).toBeInTheDocument();
    setDraft(docOf(131_071));
    expect(screen.queryByText(QUERY_TOO_LARGE)).toBeNull();
    runKey();
    await waitFor(() => {
      expect(alertText()).toBe(TOO_LONG);
    });
    await flush();
    expect(spies.range).toHaveBeenCalledTimes(1);
  });

  it('R7 the width arrives after the draft', async () => {
    const api = new StubApi();
    const spies = spyBoth(api);
    const { router } = openExplore(url(), { api });
    await screen.findByRole('heading', { level: 2, name: 'Result' });
    await screen.findByRole('textbox', { name: 'PromQL query' });
    await flush();
    setDraft(R4);
    expect(runButton()).toBeDisabled();
    expect(screen.getByText(WAITING).closest('[role]')).toHaveAttribute('role', 'status');
    runKey();
    await flush();
    noCall(spies);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(router.state.location.search).not.toContain('q=');
    act(() => {
      resizeAll(1000, 240);
    });
    await waitFor(() => {
      expect(runButton()).toBeEnabled();
    });
    expect(screen.queryByText(WAITING)).toBeNull();
    runKey();
    await waitFor(() => {
      expect(alertText()).toBe(TOO_LONG);
    });
    await flush();
    expect(spies.range).toHaveBeenCalledTimes(1);
    expect(router.state.location.search).toContain('q=');
    expect(router.state.historyAction).toBe('PUSH');
  });

  it("R8 metric types are the stub's, not a gate", async () => {
    const XC = 'x_c{a="' + 'b'.repeat(65_518) + '"}';
    expect(queryBytes(XC)).toBe(65_527);
    for (const outcome of ['resolve', 'reject'] as const) {
      const api = new StubApi();
      const meta = deferred<PromMetadata>();
      vi.spyOn(api, 'promMetadata').mockReturnValue(meta.promise);
      const spy = vi.spyOn(api, 'queryRange');
      openExplore(url(), { api });
      const run = await ready();
      expect(run).toBeEnabled();
      setDraft(XC);
      runKey();
      await waitFor(() => {
        expect(spy).toHaveBeenCalledTimes(1);
      });
      expect(spy.mock.calls[0]?.[1].query).toBe(XC);
      await act(async () => {
        if (outcome === 'resolve') {
          meta.resolve({
            metrics: { x_c: [{ type: 'counter', help: '', unit: '' }] },
            completeness: EMPTY_COMPLETENESS,
          });
        } else meta.reject(new ApiError('unavailable', 'down'));
        await Promise.resolve();
      });
      if (outcome === 'resolve') {
        await waitFor(() => {
          expect(alertText()).toBe(TOO_LONG);
        });
      } else {
        const box = await screen.findByRole('status', { name: 'Query notices' });
        expect(box).toHaveTextContent(WARN_TYPES_UNAVAILABLE);
        expect(screen.queryByRole('alert')).toBeNull();
      }
      cleanup();
    }
  });
});
