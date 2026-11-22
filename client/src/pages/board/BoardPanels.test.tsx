/**
 * Board PromQL panels (plan #64 §5.1): the run, auto-vis, visible-only queries, the window epoch,
 * refresh (#101), variables, states, the panel menu and the query field of the panel editor.
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StubApi, type StubSeed } from '../../api/StubApi';
import {
  ApiError,
  type InstantRequest,
  type PanelSpec,
  type PlannedQuery,
  type RangeRequest,
} from '../../api/types';
import type { InstantResult, RangeResult } from '../../data/decode';
import type { FrameData } from '../../data/frames';
import { LANGUAGES } from '../../editor/lang/index';
import { refusalText } from '../../explore/statusText';
import { resetQueryLanguages } from '../../boards/useQueryLanguage';
import { contextSearchString } from '../../state/contextSearch';
import {
  boardWith,
  deferred,
  engineWrapper,
  panel,
  panelOf,
  panelState,
  stubBoard,
} from '../../test/boardTestKit';
import { fakeEditorSource } from '../../test/fakeEditor';
import { fakeEngine, type FakeEngine, type FakeFrame } from '../../test/fakeEngine';
import {
  installIntersectionObserver,
  observedCount,
  setVisible,
  uninstallIntersectionObserver,
} from '../../test/fakeIntersectionObserver';
import { F } from '../../test/fakePromSource';
import { installResizeObserver, resizeAll } from '../../test/fakeResizeObserver';
import { C0, R_A, R_B, R_H1 } from '../../test/rangeFixtures';
import { renderApp, T } from '../../test/renderApp';
import { seedWith } from '../../test/seeds';

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

const T12 = Date.UTC(2026, 10, 19, 12);
const T13 = Date.UTC(2026, 10, 19, 13);
const HOUR = 3_600_000;
const ABS = 'from=2026-11-19T12:00:00.000Z&to=2026-11-19T13:00:00.000Z&refresh=off';
const ABS24 = 'from=2026-11-18T13:00:00.000Z&to=2026-11-19T13:00:00.000Z&refresh=off';
const REL = 'from=now-1h&to=now&refresh=off';
const ABS_SEARCH = contextSearchString({
  from: '2026-11-19T12:00:00.000Z',
  to: '2026-11-19T13:00:00.000Z',
  refresh: 'off',
});
const MIX = 'avg_over_time(x[$__interval]) + rate(y[$__rate_interval])';

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

interface Opts {
  search?: string;
  extra?: string;
  now?: number | (() => number);
  seed?: StubSeed;
  url?: string;
}

function openBoard(panels: readonly PanelSpec[], o: Opts = {}) {
  const api = new StubApi(o.seed ?? boardWith(panels));
  const range = vi.spyOn(api, 'queryRange');
  const instant = vi.spyOn(api, 'queryInstant');
  const engine = fakeEngine();
  const url = o.url ?? `/t/demo/board/b-1?${o.search ?? ABS}${o.extra ?? ''}`;
  const r = renderApp(url, {
    api,
    wrapper: engineWrapper(engine),
    ...(o.now === undefined ? {} : { now: o.now }),
  });
  return { ...r, api, range, instant, engine };
}
type Board = ReturnType<typeof openBoard>;

/** Waits for the panels, then gives every panel body 1000 × 240 (step 5 s on 1 h). */
async function ready(...titles: string[]): Promise<void> {
  for (const title of titles) await screen.findByRole('heading', { level: 3, name: title });
  act(() => {
    resizeAll(1000, 240);
  });
}

function show(...titles: string[]): void {
  for (const title of titles) setVisible(panelOf(title), true);
}

function hide(...titles: string[]): void {
  for (const title of titles) setVisible(panelOf(title), false);
}

async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((r) => {
        setTimeout(r, 0);
      });
    });
  }
}

/** The language has loaded and every effect it started has run. */
async function settledLanguage(): Promise<void> {
  await LANGUAGES.promql();
  await flush();
}

const reqs = (t: Board): RangeRequest[] => t.range.mock.calls.map((c) => c[1]);
const signals = (t: Board): (AbortSignal | undefined)[] => t.range.mock.calls.map((c) => c[2]);

async function calls(t: Board, n: number): Promise<void> {
  await waitFor(() => {
    expect(t.range).toHaveBeenCalledTimes(n);
  });
}

/** The live frame drawn inside the panel titled `title`. */
function frameOf(t: Board, title: string): FakeFrame | undefined {
  const p = panelOf(title);
  return t.engine.frames.findLast((f) => f.disposed === 0 && p.contains(f.canvas));
}

function lastData(t: Board, title: string): FrameData | undefined {
  return frameOf(t, title)?.last('setData')?.[0] as FrameData | undefined;
}

function seriesValues(t: Board, title: string): number[][] | null {
  const d = lastData(t, title);
  return d?.kind === 'series' ? d.series.map((s) => Array.from(s.values)) : null;
}

async function settled(t: Board, title: string): Promise<void> {
  await waitFor(() => {
    expect(panelState(title)).toBe('frame');
  });
  await waitFor(() => {
    expect(frameOf(t, title)).toBeDefined();
  });
}

interface Held<R, T> {
  readonly req: R;
  readonly signal: AbortSignal | undefined;
  resolve(v?: T): Promise<void>;
  reject(e: Error): Promise<void>;
}

/** From now on `queryRange` calls wait for the test; `stop()` makes them call through again. */
function holdRange(t: Board) {
  const held: Held<RangeRequest, RangeResult>[] = [];
  let on = true;
  t.range.mockImplementation((tenant, req, signal) => {
    if (!on) return StubApi.prototype.queryRange.call(t.api, tenant, req, signal);
    return new Promise<RangeResult>((res, rej) => {
      signal?.addEventListener('abort', () => {
        rej(new DOMException('aborted', 'AbortError'));
      });
      held.push({
        req,
        signal,
        resolve: (v) =>
          act(async () => {
            res(v ?? (await StubApi.prototype.queryRange.call(t.api, tenant, req)));
            await Promise.resolve();
          }),
        reject: (e) =>
          act(async () => {
            rej(e);
            await Promise.resolve();
          }),
      });
    });
  });
  return {
    held,
    stop: () => {
      on = false;
    },
  };
}

function windowKey(key: ']' | '['): void {
  fireEvent.keyDown(document.body, { key, code: key === ']' ? 'BracketRight' : 'BracketLeft' });
}

function exploreItem(title: string): Promise<HTMLElement> {
  return screen.findByRole('menuitem', { name: 'Open in Explore' }).then((el) => {
    expect(el.closest('[role="menu"]')).toHaveAccessibleName(`Panel menu: ${title}`);
    return el;
  });
}

async function openMenu(t: Board, title: string): Promise<void> {
  await t.user.click(screen.getByRole('button', { name: `Panel menu: ${title}` }));
  await screen.findByRole('menu', { name: `Panel menu: ${title}` });
}

async function closeMenu(t: Board): Promise<void> {
  await t.user.keyboard('{Escape}');
  await waitFor(() => {
    expect(screen.queryByRole('menu')).toBeNull();
  });
}

const qOf = (href: string | null): string | null =>
  href === null ? null : new URL(href, 'http://x').searchParams.get('q');

/** The Open in Explore header tool and menu item of `title`, enabled or not, and the href. */
async function exploreState(t: Board, title: string) {
  await openMenu(t, title);
  const item = await exploreItem(title);
  const itemHref = item.getAttribute('href');
  const disabled = item.getAttribute('aria-disabled') === 'true';
  await closeMenu(t);
  const name = `Open in Explore: ${title}`;
  const link = screen.queryByRole('link', { name });
  const button = screen.queryByRole('button', { name });
  return { itemHref, disabled, link, button };
}

async function editorOn(t: Board, title: string): Promise<HTMLElement> {
  await openMenu(t, title);
  await t.user.click(await screen.findByRole('menuitem', { name: 'Edit panel' }));
  const d = await screen.findByRole('dialog', { name: 'Edit panel' });
  await within(d).findByRole('textbox', { name: 'Query' });
  return d;
}

function preview(d: HTMLElement): HTMLElement {
  return within(d).getByRole('region', { name: 'Preview' });
}

function typeQuery(d: HTMLElement, value: string): void {
  fireEvent.input(within(d).getByRole('textbox', { name: 'Query' }), { target: { value } });
}

function runKeys(d: HTMLElement): void {
  fireEvent.keyDown(within(d).getByRole('textbox', { name: 'Query' }), {
    key: 'Enter',
    shiftKey: true,
  });
}

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
      Stream: 'The log stream arrives with LogQL panels',
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
    await settled(t, 'Mem B');
    windowKey(']');
    await calls(t, 4);
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
    expect(panelOf('Requests')).toHaveAttribute('aria-busy', 'true');
    expect(panelOf('Requests').querySelector('[role="progressbar"]')).toBeNull();
    await act(async () => {
      await h.held[0]?.resolve(R_B);
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(shimmer()).toBeNull();
  });
});

describe('variables and macros', () => {
  it('variables are sent', async () => {
    const t = openBoard(
      [panel('p-1', 'Regional', 'up{region="$region"}'), panel('p-2', 'Plain', 'up')],
      { extra: '&var-other=x&var-region=eu' },
    );
    await ready('Regional', 'Plain');
    show('Regional', 'Plain');
    await calls(t, 2);
    const byQuery = new Map(t.range.mock.calls.map((c, i) => [c[1].query, i]));
    const first = byQuery.get('up{region="$region"}') ?? -1;
    expect(t.range.mock.calls[first]?.[1].vars).toEqual({ region: 'eu' });
    const r = await (t.range.mock.results[first]?.value as Promise<RangeResult>);
    expect(r.planned.query).toBe('up{region="eu"}');
    expect(t.range.mock.calls[byQuery.get('up') ?? -1]?.[1].vars).toEqual({});
    await act(async () => {
      await t.router.navigate(`/t/demo/board/b-1?${ABS}&var-other=x&var-region=us`);
    });
    await calls(t, 3);
    await flush();
    expect(t.range).toHaveBeenCalledTimes(3);
    expect(reqs(t)[2]).toMatchObject({ query: 'up{region="$region"}', vars: { region: 'us' } });
  });

  it('macros', async () => {
    const t = openBoard([
      panel('p-1', 'Rate', 'rate(x[$__rate_interval])'),
      panel('p-2', 'Avg', 'avg_over_time(x[$__interval])'),
    ]);
    await ready('Rate', 'Avg');
    show('Rate', 'Avg');
    await calls(t, 2);
    const planned = new Map<string, string>();
    for (const [i, c] of t.range.mock.calls.entries()) {
      expect(c[1].vars).toEqual({});
      const r = await (t.range.mock.results[i]?.value as Promise<RangeResult>);
      planned.set(c[1].query, r.planned.query);
    }
    expect(planned.get('rate(x[$__rate_interval])')).toBe('rate(x[1m])');
    expect(planned.get('avg_over_time(x[$__interval])')).toBe('avg_over_time(x[5s])');
  });
});

describe('panel errors and notices', () => {
  it.each([
    [3, 'bad (line 1, column 3)'],
    [undefined, 'bad (position unknown)'],
  ] as const)('error with its position: %s', async (position, text) => {
    const t = openBoard([panel('p-1', 'Broken', 'up{')]);
    t.range.mockRejectedValue(
      new ApiError('queryInvalid', 'bad', {
        detail: position === undefined ? {} : { position },
      }),
    );
    await ready('Broken');
    show('Broken');
    expect(await within(panelOf('Broken')).findByText('Something went wrong')).toBeInTheDocument();
    expect(within(panelOf('Broken')).getByRole('alert')).toHaveTextContent(text);
    expect(panelState('Broken')).toBe('error');
  });

  it('server reports a missing variable', async () => {
    const t = openBoard([panel('p-1', 'Zone', 'up{z="$zone"}')], { extra: '&var-zone=a' });
    t.range.mockRejectedValue(
      new ApiError('invalid', 'm', {
        fields: [{ pointer: '/vars/zone', messageKey: 'variable.missing' }],
      }),
    );
    await ready('Zone');
    show('Zone');
    expect(
      await within(panelOf('Zone')).findByText('Set a value for $zone to run this panel'),
    ).toBeInTheDocument();
    expect(panelState('Zone')).toBe('variable');
    expect(within(panelOf('Zone')).queryByRole('alert')).toBeNull();
  });

  it.each([
    [10, '(line 1, column 11)'],
    [5, '(line 1, column 6)'],
  ])('error position is the raw offset: %s', async (position, text) => {
    const t = openBoard([panel('p-1', 'Raw', 'x{a="$v"} +')], { extra: '&var-v=long_value' });
    t.range.mockRejectedValue(new ApiError('queryInvalid', 'bad', { detail: { position } }));
    await ready('Raw');
    show('Raw');
    await waitFor(() => {
      expect(within(panelOf('Raw')).getByRole('alert')).toHaveTextContent(`bad ${text}`);
    });
  });

  it('narrow from a panel error', async () => {
    const t = openBoard([panel('p-1', 'Broad', 'up')]);
    t.range.mockRejectedValue(new ApiError('tooBroad', 'too many series'));
    await ready('Broad');
    show('Broad');
    const narrow = await within(panelOf('Broad')).findByRole('button', {
      name: 'Narrow the time range',
    });
    fireEvent.click(narrow);
    await waitFor(() => {
      const p = new URLSearchParams(t.router.state.location.search);
      expect([p.get('from'), p.get('to')]).toEqual([
        '2026-11-19T12:15:00.000Z',
        '2026-11-19T12:45:00.000Z',
      ]);
    });
  });

  it('partial data badge', async () => {
    const t = openBoard([panel('p-1', 'Requests', 'a'), panel('p-2', 'Other', 'b')]);
    t.range.mockImplementation((_tenant, req) =>
      Promise.resolve({
        ...R_A,
        completeness:
          req.query === 'a'
            ? { ...C0, truncated: true, warnings: ['w1'] }
            : { ...C0, warnings: ['w2'] },
      }),
    );
    await ready('Requests', 'Other');
    show('Requests', 'Other');
    const badge = await screen.findByRole('button', { name: 'Partial data: Requests' });
    await t.user.click(badge);
    const notices = await screen.findByRole('status', { name: 'Query notices' });
    expect(notices).toHaveTextContent('w1');
    expect(within(notices).getByRole('button', { name: 'Narrow the time range' })).toBeVisible();
    await t.user.keyboard('{Escape}');
    await t.user.click(await screen.findByRole('button', { name: 'Warnings: Other' }));
    const other = await screen.findByRole('status', { name: 'Query notices' });
    expect(other).toHaveTextContent('w2');
    expect(within(other).queryByRole('button', { name: 'Narrow the time range' })).toBeNull();
  });

  it('refused over 128 KB', async () => {
    const t = openBoard([panel('p-1', 'Huge', 'a'.repeat(131_073))]);
    await ready('Huge');
    show('Huge');
    expect(
      await within(panelOf('Huge')).findByText(refusalText('queryTooLarge')),
    ).toBeInTheDocument();
    await settledLanguage();
    expect(t.range).not.toHaveBeenCalled();
  });

  it.each(['planned', 'processing_cap'] as const)('server refuses over 64 KiB: %s', async (c) => {
    const P: PlannedQuery = {
      query: 'q',
      expanded: 'q',
      bytes: 65_540,
      valueType: 'vector',
      rateCandidate: false,
      rateApplied: false,
      histogram: false,
      stepMs: 5000,
    };
    const t = openBoard([panel('p-1', 'Long', 'up')]);
    t.range.mockRejectedValue(
      new ApiError('queryTooLong', 'm', {
        detail: c === 'planned' ? { planned: P } : { hint: { reason: 'processing_cap' } },
      }),
    );
    await ready('Long');
    show('Long');
    expect(await within(panelOf('Long')).findByText(refusalText('tooLong'))).toBeInTheDocument();
    expect(panelState('Long')).toBe('refused');
    expect(within(panelOf('Long')).queryByRole('alert')).toBeNull();
    if (c === 'processing_cap') {
      const s = await exploreState(t, 'Long');
      expect(s.disabled).toBe(true);
      expect(s.button).toBeDisabled();
    }
  });
});

describe('panel menu', () => {
  it('menu: duplicate', async () => {
    const t = openBoard([panel('p-1', 'Requests', 'node_memory_free_bytes')]);
    await ready('Requests');
    show('Requests');
    await calls(t, 1);
    await openMenu(t, 'Requests');
    await t.user.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
    await screen.findByRole('button', { name: 'Save' });
    const copy = await screen.findByRole('heading', { level: 3, name: 'Requests (copy)' });
    expect(copy.closest('[data-panel]')).toHaveAttribute('data-grid', '6,0,6,8');
    await waitFor(() => {
      expect(document.querySelector('[data-board-live]')).toHaveTextContent(
        'Panel duplicated: Requests (copy)',
      );
    });
    await waitFor(() => {
      expect(document.querySelectorAll('.react-grid-item')).toHaveLength(2);
    });
    act(() => {
      resizeAll(1000, 240);
    });
    show('Requests', 'Requests (copy)');
    await calls(t, 2);
    await flush();
    expect(t.range).toHaveBeenCalledTimes(2);
  });

  it('menu: remove', async () => {
    const t = openBoard([
      panel('p-1', 'Requests', 'node_memory_free_bytes'),
      panel('p-2', 'Other', 'up'),
    ]);
    await ready('Requests');
    await openMenu(t, 'Requests');
    await t.user.click(screen.getByRole('menuitem', { name: 'Remove' }));
    await screen.findByRole('button', { name: 'Save' });
    await waitFor(() => {
      expect(screen.queryByRole('heading', { level: 3, name: 'Requests' })).toBeNull();
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Add panel' })).toHaveFocus();
    });
  });

  it('menu: open in Explore', async () => {
    const t = openBoard([panel('p-1', 'Regional', 'up{region="$region"}', 'bars')], {
      extra: '&var-region=eu',
    });
    const h = holdRange(t);
    await ready('Regional');
    show('Regional');
    await calls(t, 1);
    const held = await exploreState(t, 'Regional');
    expect(held.disabled).toBe(true);
    expect(held.button).toBeDisabled();
    expect(held.link).toBeNull();
    await h.held[0]?.resolve();
    await settled(t, 'Regional');
    const s = await exploreState(t, 'Regional');
    expect(s.disabled).toBe(false);
    expect(s.itemHref).toBe(
      `/t/demo/explore/metrics${ABS_SEARCH}&q=up%7Bregion%3D%22eu%22%7D&vis=bars`,
    );
    expect(s.link).toHaveAttribute('href', s.itemHref);
  });

  it('open in Explore takes expanded, not query', async () => {
    const t = openBoard([panel('p-1', 'Requests', 'http_requests_total')]);
    await ready('Requests');
    show('Requests');
    await settled(t, 'Requests');
    expect(qOf((await exploreState(t, 'Requests')).itemHref)).toBe('http_requests_total');
  });

  it.each([
    [ABS, 'avg_over_time(x[5s]) + rate(y[1m])'],
    [ABS24, 'avg_over_time(x[5m]) + rate(y[20m])'],
  ])('open in Explore keeps the macros: %s', async (search, want) => {
    const t = openBoard([panel('p-1', 'Mix', MIX)], { search });
    await ready('Mix');
    show('Mix');
    await settled(t, 'Mix');
    const r = await (t.range.mock.results[0]?.value as Promise<RangeResult>);
    expect(r.planned.expanded).toBe(want);
    expect(qOf((await exploreState(t, 'Mix')).itemHref)).toBe(want);
    await openMenu(t, 'Mix');
    await t.user.click(await exploreItem('Mix'));
    await waitFor(() => {
      expect(t.router.state.location.pathname).toBe('/t/demo/explore/metrics');
    });
    const p = new URLSearchParams(t.router.state.location.search);
    const b = new URLSearchParams(search);
    expect([p.get('from'), p.get('to'), p.get('q')]).toEqual([b.get('from'), b.get('to'), want]);
    expect(
      await screen.findByRole<HTMLTextAreaElement>('textbox', { name: 'PromQL query' }),
    ).toHaveValue(want);
  });

  it('open in Explore after a resize', async () => {
    const t = openBoard([panel('p-1', 'Mix', MIX)]);
    await ready('Mix');
    show('Mix');
    await settled(t, 'Mix');
    act(() => {
      resizeAll(200, 240);
    });
    await calls(t, 2);
    await settled(t, 'Mix');
    await waitFor(async () => {
      expect(qOf((await exploreState(t, 'Mix')).itemHref)).toBe(
        'avg_over_time(x[30s]) + rate(y[2m])',
      );
    });
  });

  describe('open in Explore follows the current key', () => {
    async function x0() {
      const t = openBoard([panel('p-1', 'Mix', MIX)]);
      await ready('Mix');
      show('Mix');
      await settled(t, 'Mix');
      const s = await exploreState(t, 'Mix');
      expect(s.disabled).toBe(false);
      expect(qOf(s.itemHref)).toBe('avg_over_time(x[5s]) + rate(y[1m])');
      expect(s.link).toHaveAttribute('href', s.itemHref);
      const p = new URL(s.itemHref ?? '', 'http://x').searchParams;
      expect([p.get('from'), p.get('to')]).toEqual([
        '2026-11-19T12:00:00.000Z',
        '2026-11-19T13:00:00.000Z',
      ]);
      return t;
    }

    it('X1: a resize', async () => {
      const t = await x0();
      const frames = t.engine.frames.length;
      const h = holdRange(t);
      act(() => {
        resizeAll(200, 240);
      });
      await calls(t, 2);
      expect(h.held[0]?.req.widthPx).toBe(200);
      expect(t.engine.frames).toHaveLength(frames);
      expect(within(panelOf('Mix')).queryByText('Loading')).toBeNull();
      const s = await exploreState(t, 'Mix');
      expect(s.disabled).toBe(true);
      expect(s.button).toBeDisabled();
      await h.held[0]?.resolve();
      await waitFor(async () => {
        expect(qOf((await exploreState(t, 'Mix')).itemHref)).toBe(
          'avg_over_time(x[30s]) + rate(y[2m])',
        );
      });
    });

    it('X2: a range change', async () => {
      const t = await x0();
      const h = holdRange(t);
      await act(async () => {
        await t.router.navigate(`/t/demo/board/b-1?${ABS24}`);
      });
      await calls(t, 2);
      expect([h.held[0]?.req.fromMs, h.held[0]?.req.toMs]).toEqual([T13 - 24 * HOUR, T13]);
      expect(within(panelOf('Mix')).queryByText('Loading')).toBeNull();
      expect((await exploreState(t, 'Mix')).disabled).toBe(true);
      await h.held[0]?.resolve();
      await waitFor(async () => {
        const s = await exploreState(t, 'Mix');
        expect(qOf(s.itemHref)).toBe('avg_over_time(x[5m]) + rate(y[20m])');
        const p = new URL(s.itemHref ?? '', 'http://x').searchParams;
        expect([p.get('from'), p.get('to')]).toEqual([
          '2026-11-18T13:00:00.000Z',
          '2026-11-19T13:00:00.000Z',
        ]);
      });
    });

    it('X3: a same-key refresh', async () => {
      const t = await x0();
      const h = holdRange(t);
      fireEvent.click(screen.getByRole('button', { name: 'Refresh now' }));
      await calls(t, 2);
      const s = await exploreState(t, 'Mix');
      expect(s.disabled).toBe(false);
      expect(qOf(s.itemHref)).toBe('avg_over_time(x[5s]) + rate(y[1m])');
      await h.held[0]?.resolve();
      expect(qOf((await exploreState(t, 'Mix')).itemHref)).toBe(
        'avg_over_time(x[5s]) + rate(y[1m])',
      );
    });

    it.each(['planned', 'none'] as const)('X4: an error after a resize: %s', async (c) => {
      const t = await x0();
      const P: PlannedQuery = {
        query: 'avg_over_time(x[30s]) + rate(y[2m])',
        expanded: 'avg_over_time(x[30s]) + rate(y[2m])',
        bytes: 35,
        valueType: 'vector',
        rateCandidate: false,
        rateApplied: false,
        histogram: false,
        stepMs: 30_000,
      };
      t.range.mockRejectedValue(
        new ApiError('queryInvalid', 'bad', { detail: c === 'planned' ? { planned: P } : {} }),
      );
      act(() => {
        resizeAll(200, 240);
      });
      await calls(t, 2);
      await waitFor(() => {
        expect(panelState('Mix')).toBe('error');
      });
      const s = await exploreState(t, 'Mix');
      if (c === 'planned') {
        expect(s.disabled).toBe(false);
        expect(qOf(s.itemHref)).toBe(P.expanded);
      } else {
        expect(s.disabled).toBe(true);
      }
    });
  });
});

describe('panel editor query field', () => {
  it('editor runs on Run', async () => {
    const t = openBoard([panel('p-1', 'Requests', 'http_requests_total')]);
    const save = vi.spyOn(t.api, 'saveBoard');
    await ready('Requests');
    show('Requests');
    await settled(t, 'Requests');
    const d = await editorOn(t, 'Requests');
    typeQuery(d, 'up');
    await flush();
    expect(t.range).toHaveBeenCalledTimes(1);
    expect(
      within(d).getByText('Press Shift+Enter or Run query to update the preview.'),
    ).toBeInTheDocument();
    runKeys(d);
    await calls(t, 2);
    await flush();
    expect(t.range).toHaveBeenCalledTimes(2);
    expect(reqs(t)[1]?.query).toBe('up');
    expect(
      within(d).queryByText('Press Shift+Enter or Run query to update the preview.'),
    ).toBeNull();
    await t.user.keyboard('{Control>}s{/Control}');
    await waitFor(() => {
      expect(save).toHaveBeenCalledTimes(1);
    });
    expect(save.mock.calls[0]?.[3].panels[0]?.query.text).toBe('up');
  });

  it('editor rerun and blur', async () => {
    const t = openBoard([panel('p-1', 'Requests', 'http_requests_total')]);
    await ready('Requests');
    show('Requests');
    await settled(t, 'Requests');
    const d = await editorOn(t, 'Requests');
    const h = holdRange(t);
    typeQuery(d, 'up');
    runKeys(d);
    await calls(t, 2);
    runKeys(d);
    await calls(t, 3);
    expect(h.held[0]?.signal?.aborted).toBe(true);
    expect(h.held.map((x) => x.req.query)).toEqual(['up', 'up']);
    h.stop();
    const box = within(d).getByRole('textbox', { name: 'Query' });
    act(() => {
      box.focus();
    });
    typeQuery(d, 'upx');
    await t.user.tab();
    await calls(t, 4);
    await flush();
    expect(t.range).toHaveBeenCalledTimes(4);
    expect(reqs(t)[3]?.query).toBe('upx');
  });

  it('editor diagnostics', async () => {
    const t = openBoard([panel('p-1', 'Requests', 'http_requests_total')]);
    await ready('Requests');
    show('Requests');
    await settled(t, 'Requests');
    const d = await editorOn(t, 'Requests');
    t.range.mockRejectedValue(new ApiError('queryInvalid', 'bad', { detail: { position: 3 } }));
    typeQuery(d, 'up{');
    runKeys(d);
    const box = within(d).getByRole('textbox', { name: 'Query' });
    await waitFor(() => {
      expect(JSON.parse(box.getAttribute('data-diagnostics') ?? '[]')).toMatchObject([
        { from: 2, to: 3 },
      ]);
    });
    typeQuery(d, 'up{x');
    await waitFor(() => {
      expect(box.getAttribute('data-diagnostics')).toBe('[]');
    });
  });

  it('editor picker', async () => {
    fakeEditorSource.data = { ...F, names: ['http_requests_total', 'node_memory_free_bytes'] };
    const t = openBoard([panel('p-1', 'Requests', 'http_requests_total')]);
    await ready('Requests');
    await t.user.click(screen.getByRole('button', { name: 'Edit board' }));
    await t.user.click(await screen.findByRole('button', { name: 'Add panel' }));
    const d = await screen.findByRole('dialog', { name: 'Edit panel' });
    const box = await within(d).findByRole<HTMLTextAreaElement>('textbox', { name: 'Query' });
    const picker = within(d).getByRole('combobox', { name: 'Metric' });
    await waitFor(() => {
      expect(picker).toBeEnabled();
    });
    await t.user.click(picker);
    await screen.findByRole('listbox');
    await t.user.keyboard('memory');
    await screen.findByRole('option', { name: /^node_memory_free_bytes/ });
    await t.user.keyboard('{Enter}');
    await waitFor(() => {
      expect(box.value).toBe('node_memory_free_bytes');
    });
  });

  it("preview shares the panel's key", async () => {
    const t = openBoard([panel('p-1', 'Requests', 'http_requests_total')]);
    await ready('Requests');
    show('Requests');
    await settled(t, 'Requests');
    const d = await editorOn(t, 'Requests');
    await waitFor(() => {
      expect(preview(d).querySelector('canvas')).not.toBeNull();
    });
    await flush();
    expect(t.range).toHaveBeenCalledTimes(1);
  });

  it('query change shows Loading', async () => {
    const t = openBoard([panel('p-1', 'Requests', 'http_requests_total')]);
    await ready('Requests');
    show('Requests');
    await settled(t, 'Requests');
    const d = await editorOn(t, 'Requests');
    const h = holdRange(t);
    typeQuery(d, 'up');
    runKeys(d);
    await calls(t, 2);
    await waitFor(() => {
      expect(within(preview(d)).getByText('Loading')).toBeInTheDocument();
    });
    expect(preview(d).querySelector('[data-chart-frame]')).toBeNull();
    expect(within(panelOf('Requests')).getByText('Loading')).toBeInTheDocument();
    await h.held[0]?.resolve();
    await waitFor(() => {
      expect(preview(d).querySelector('[data-chart-frame]')).not.toBeNull();
    });
  });
});

describe('board time on open', () => {
  /** b-1 saved `now-6h…now`, b-2 none and b-3 none, with the same panels. */
  function seed(): StubSeed {
    const panels = [panel('p-1', 'Mem A', 'm1'), panel('p-2', 'Mem B', 'm2')];
    return seedWith({
      boards: [
        stubBoard('b-1', {
          title: 'Saved',
          time: { from: 'now-6h', to: 'now' },
          panels,
          sections: [],
        }),
        stubBoard('b-2', { title: 'Plain', panels, sections: [] }),
        stubBoard('b-3', { title: 'Other', panels, sections: [] }),
      ],
    });
  }

  it('saved time when the URL has none', async () => {
    uninstallIntersectionObserver();
    const t = openBoard([], { seed: seed(), url: '/t/demo/board/b-1' });
    await ready('Mem A', 'Mem B');
    await calls(t, 2);
    expect(t.router.state.location.search).toBe('?from=now-6h&to=now&refresh=off');
    for (const r of reqs(t)) expect(r.toMs - r.fromMs).toBe(6 * HOUR);
  });

  async function warm(): Promise<Board> {
    uninstallIntersectionObserver();
    const t = openBoard([], { seed: seed(), url: `/t/demo/board/b-2?${REL}` });
    await ready('Mem A', 'Mem B');
    await calls(t, 2);
    await settled(t, 'Mem B');
    await import('../../editor/editor');
    for (const uid of ['b-1', 'b-3']) {
      await t.queryClient.prefetchQuery({
        queryKey: ['board', 'demo', uid],
        queryFn: () => t.api.getBoard('demo', uid),
      });
    }
    t.range.mockClear();
    return t;
  }

  it.each(['plain link', 'board link'] as const)('saved time with warm caches: %s', async (c) => {
    const t = await warm();
    const seen: string[] = [];
    t.range.mockImplementation((tenant, req, s) => {
      seen.push(t.router.state.location.search);
      return StubApi.prototype.queryRange.call(t.api, tenant, req, s);
    });
    await act(async () => {
      if (c === 'plain link') await t.router.navigate('/t/demo/board/b-1');
      else {
        await t.router.navigate(`/t/demo/board/b-1?${REL}`, { state: { applySavedTime: true } });
      }
    });
    await screen.findByRole('heading', { level: 1, name: 'Saved' });
    act(() => {
      resizeAll(1000, 240);
    });
    await calls(t, 2);
    await flush();
    expect(t.range).toHaveBeenCalledTimes(2);
    for (const r of reqs(t)) expect(r.toMs - r.fromMs).toBe(6 * HOUR);
    for (const s of seen) expect(new URLSearchParams(s).get('from')).toBe('now-6h');
    expect(t.router.state.location.search).toBe('?from=now-6h&to=now&refresh=off');
  });

  it('default time with warm caches', async () => {
    const t = await warm();
    const seen: string[] = [];
    t.range.mockImplementation((tenant, req, s) => {
      seen.push(t.router.state.location.search);
      return StubApi.prototype.queryRange.call(t.api, tenant, req, s);
    });
    await act(async () => {
      await t.router.navigate('/t/demo/board/b-3');
    });
    await screen.findByRole('heading', { level: 1, name: 'Other' });
    act(() => {
      resizeAll(1000, 240);
    });
    await calls(t, 2);
    for (const r of reqs(t)) expect(r.toMs - r.fromMs).toBe(HOUR);
    for (const s of seen) expect(s).toBe('?from=now-1h&to=now&refresh=off');
  });
});
