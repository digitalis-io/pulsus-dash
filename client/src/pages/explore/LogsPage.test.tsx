// unit:logs-page (plan #66 Part C §3.9, §4, §5.2): Explore › Logs in jsdom, LP1–LP23 (LP20, the
// chunk that fails to load, is in LogsPage.fallback.test.tsx: its mock rejects for the whole file).
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/types';
import type { FrameData } from '../../data/frames';
import type { VisSpec } from '../../engine/api';
import { LogPager } from '../../logs/logPager';
import { installResizeObserver } from '../../test/fakeResizeObserver';
import {
  flush,
  HOUR,
  installLogsLayout,
  listItems,
  logsUrl,
  openLogs,
  page,
  ready,
  resizeColumn,
  rowsOf,
  runButton,
  runKey,
  scriptedLogsPageApi,
  seriesAnswer,
  setDraft,
  sized,
  textbox,
  volumeAnswer,
  W0,
  type Engine,
} from '../../test/logsPageKit';

vi.mock('../../editor/logqlEditor', () => import('../../test/fakeLogqlEditor'));

const QUERY_TOO_LARGE =
  'This query is over 128 KB. Completion is paused, and it cannot be run until it is shorter.';
const MIN = 60_000;

let restoreLayout: () => void = () => undefined;
beforeEach(() => {
  installResizeObserver();
  restoreLayout = installLogsLayout();
});
afterEach(() => {
  restoreLayout();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** The card titled `name` (its `<section>`). */
function card(name: string): HTMLElement {
  const h = screen.getByRole('heading', { level: 2, name });
  const s = h.closest('section');
  if (s === null) throw new Error(`no card ${name}`);
  return s;
}

function lastData(engine: Engine): FrameData | undefined {
  return engine.frames.at(-1)?.last('setData')?.[0] as FrameData | undefined;
}

function lastSpec(engine: Engine): VisSpec | undefined {
  return engine.frames.at(-1)?.last('setSpec')?.[0] as VisSpec | undefined;
}

/** The ChartFrames in the document. */
function frames(): Element[] {
  return [...document.querySelectorAll('[data-chart-frame]')];
}

function search(router: ReturnType<typeof openLogs>['router']): URLSearchParams {
  return new URLSearchParams(router.state.location.search);
}

const lines = (): string[] => listItems().map((e) => e.textContent);

/** Opens `q` on the scripted API with the column sized and waits for the first page request. */
async function opened(q: string, o: { url?: string; now?: () => number } = {}) {
  const s = scriptedLogsPageApi();
  const r = openLogs(o.url ?? logsUrl(q), {
    api: s.api,
    ...(o.now === undefined ? {} : { now: o.now }),
  });
  await ready();
  await waitFor(() => {
    expect(s.logs).toHaveLength(1);
  });
  return { ...s, ...r };
}

describe('unit:logs-page', () => {
  it('LP1 no q: the empty state, no request, Run enabled once loaded', async () => {
    const s = scriptedLogsPageApi();
    openLogs(logsUrl(), { api: s.api });
    const run = await ready();
    expect(screen.getByText('Run a query to see log lines')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Write a LogQL query, for example {app="checkout"} |= "error", and press Run.',
      ),
    ).toBeInTheDocument();
    expect(run).toBeEnabled();
    await flush();
    expect(s.logs).toHaveLength(0);
    expect(s.volume).toHaveLength(0);
  });

  it('LP2 q: the raw text, the window and the width to both routes', async () => {
    const s = await opened('{app="a"}');
    await waitFor(() => {
      expect(s.volume).toHaveLength(1);
    });
    expect(s.logs[0]?.tenant).toBe('demo');
    expect(s.logs[0]?.req).toEqual({
      query: '{app="a"}',
      fromMs: W0,
      toMs: W0 + HOUR,
      widthPx: 960,
      limit: 1000,
      direction: 'backward',
    });
    expect(s.logs[0]?.req.cursor).toBeUndefined();
    expect(s.volume[0]?.req).toEqual({
      query: '{app="a"}',
      fromMs: W0,
      toMs: W0 + HOUR,
      widthPx: 960,
    });
  });

  it('LP3 a streams page and its volume: Volume and Log lines, the status line', async () => {
    const s = await opened('{app="a"}');
    await s.volume[0]?.resolve(volumeAnswer());
    await s.logs[0]?.resolve(page(rowsOf(3), 'c1'));
    expect(screen.getByRole('heading', { level: 2, name: 'Volume' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Log lines' })).toBeInTheDocument();
    expect(lastSpec(s.engine)?.kind).toBe('bars');
    await waitFor(() => {
      expect(lines()).toEqual(['line 0', 'line 1', 'line 2']);
    });
    expect(screen.getByText('Log lines · newest first')).toBeInTheDocument();
    await waitFor(() => {
      expect(s.logs).toHaveLength(2);
    });
    expect(s.logs[1]?.req.cursor).toBe('c1');
    await s.logs[1]?.resolve(page([], null));
    expect(await screen.findByText('3 log lines · newest first')).toBeInTheDocument();
  });

  it('LP4 a series answer: Result with a line chart, no stream and no volume', async () => {
    const s = await opened('sum(count_over_time({app="a"}[1m]))');
    await s.logs[0]?.resolve(seriesAnswer());
    await s.volume[0]?.reject(new ApiError('unavailable', 'down'));
    expect(await screen.findByRole('heading', { level: 2, name: 'Result' })).toBeInTheDocument();
    expect(lastSpec(s.engine)?.kind).toBe('line');
    expect(screen.queryByRole('list', { name: 'Log lines' })).toBeNull();
    expect(screen.queryByRole('heading', { level: 2, name: 'Volume' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('LP5 Refresh now under an absolute window reruns the page and the volume', async () => {
    const s = await opened('{app="a"}');
    await s.volume[0]?.resolve(volumeAnswer());
    await s.logs[0]?.resolve(page(rowsOf(3), null));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh now' }));
    await waitFor(() => {
      expect(s.logs).toHaveLength(2);
      expect(s.volume).toHaveLength(2);
    });
    expect(s.logs[1]?.req.cursor).toBeUndefined();
    expect(s.logs[1]?.req).toEqual(s.logs[0]?.req);
    // A second refresh while the rerun is in flight aborts it.
    fireEvent.click(screen.getByRole('button', { name: 'Refresh now' }));
    await waitFor(() => {
      expect(s.logs).toHaveLength(3);
    });
    expect(s.logs[1]?.signal?.aborted).toBe(true);
    expect(s.volume[1]?.signal?.aborted).toBe(true);
  });

  it('LP6 Refresh now under a relative window that moved makes one new page request', async () => {
    let now = W0 + HOUR;
    const s = await opened('{app="a"}', {
      url: logsUrl('{app="a"}', '', 'demo', 'from=now-1h&to=now&refresh=off'),
      now: () => now,
    });
    now += MIN;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh now' }));
    await waitFor(() => {
      expect(s.logs).toHaveLength(2);
    });
    await flush();
    expect(s.logs).toHaveLength(2);
    expect(s.logs[1]?.req.toMs).toBe((s.logs[0]?.req.toMs ?? 0) + MIN);
  });

  it('LP7 Run with the draft equal to q reruns both and aborts the previous requests', async () => {
    const s = await opened('{app="a"}');
    await waitFor(() => {
      expect(s.volume).toHaveLength(1);
    });
    fireEvent.click(runButton());
    await waitFor(() => {
      expect(s.logs).toHaveLength(2);
      expect(s.volume).toHaveLength(2);
    });
    expect(s.logs[0]?.signal?.aborted).toBe(true);
    expect(s.volume[0]?.signal?.aborted).toBe(true);
    expect(s.logs[1]?.req).toEqual(s.logs[0]?.req);
  });

  it('LP8 Run with a new draft pushes q and runs the new text', async () => {
    const s = await opened('{app="a"}');
    setDraft('{app="b"}');
    runKey();
    await waitFor(() => {
      expect(search(s.router).get('q')).toBe('{app="b"}');
    });
    expect(s.router.state.historyAction).toBe('PUSH');
    await waitFor(() => {
      expect(s.logs).toHaveLength(2);
      expect(s.volume).toHaveLength(2);
    });
    expect(s.logs[1]?.req.query).toBe('{app="b"}');
    expect(s.volume[1]?.req.query).toBe('{app="b"}');
  });

  it('LP9 the Order control replaces dir and reruns the page only', async () => {
    const s = await opened('{app="a"}');
    await s.logs[0]?.resolve(page(rowsOf(3), null));
    await waitFor(() => {
      expect(s.volume).toHaveLength(1);
    });
    fireEvent.click(await screen.findByRole('radio', { name: 'Oldest first' }));
    await waitFor(() => {
      expect(search(s.router).get('dir')).toBe('forward');
    });
    expect(s.router.state.historyAction).toBe('REPLACE');
    await waitFor(() => {
      expect(s.logs).toHaveLength(2);
    });
    expect(s.logs[1]?.req.direction).toBe('forward');
    await flush();
    expect(s.volume).toHaveLength(1);
  });

  it('LP10 Wrap lines replaces wrap and makes no request', async () => {
    const s = await opened('{app="a"}');
    await s.logs[0]?.resolve(page(rowsOf(3), null));
    await waitFor(() => {
      expect(s.volume).toHaveLength(1);
    });
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Wrap lines' }));
    await waitFor(() => {
      expect(search(s.router).get('wrap')).toBe('on');
    });
    expect(s.router.state.historyAction).toBe('REPLACE');
    await flush();
    expect(s.logs).toHaveLength(1);
    expect(s.volume).toHaveLength(1);
    expect(document.querySelector('[data-wrap]')).toHaveAttribute('data-wrap', 'true');
  });

  it('LP11 a query_invalid first page underlines and alerts', async () => {
    const s = await opened('{app="x"');
    await s.logs[0]?.reject(
      new ApiError('queryInvalid', "unexpected end of query at byte 8: expected '}'", {
        detail: { position: 8 },
      }),
    );
    // Byte 8 is the end of the text: its last character is marked (`positionDiagnostics`).
    await waitFor(() => {
      const d = JSON.parse(textbox().dataset['diagnostics'] ?? '[]') as unknown[];
      expect(d).toEqual([expect.objectContaining({ from: 7, to: 8, positionKnown: true })]);
    });
    const d = JSON.parse(textbox().dataset['diagnostics'] ?? '[]') as { message: string }[];
    const status = within(card('Query')).getByRole('alert');
    expect(status).toHaveTextContent(d[0]?.message ?? 'none');
  });

  it('LP12 a too broad first page offers Narrow; Narrow reruns on the middle half', async () => {
    const s = await opened('{app=~".+"}');
    await s.logs[0]?.reject(new ApiError('tooBroad', 'query too broad'));
    const alert = await within(card('Query')).findByRole('alert');
    expect(alert).toHaveTextContent('query too broad');
    fireEvent.click(within(alert).getByRole('button', { name: 'Narrow the time range' }));
    await waitFor(() => {
      expect(search(s.router).get('from')).toBe(new Date(W0 + 15 * MIN).toISOString());
    });
    expect(search(s.router).get('to')).toBe(new Date(W0 + 45 * MIN).toISOString());
    await waitFor(() => {
      expect(s.logs).toHaveLength(2);
      expect(s.volume).toHaveLength(2);
    });
    expect(s.logs[1]?.req.fromMs).toBe(W0 + 15 * MIN);
    expect(s.volume[1]?.req.toMs).toBe(W0 + 45 * MIN);
  });

  it('LP13 partial data in each card, with Narrow on the stream', async () => {
    const s = await opened('{app="a"}');
    await s.logs[0]?.resolve(
      page(rowsOf(3), null, { truncated: true, warnings: ['results truncated due to limit'] }),
    );
    await s.volume[0]?.resolve(volumeAnswer(['error'], { truncated: true }));
    const stream = card('Log lines');
    const notice = within(stream).getByRole('status', { name: 'Query notices' });
    expect(notice).toHaveTextContent('Partial data');
    expect(
      within(notice).getByRole('button', { name: 'Narrow the time range' }),
    ).toBeInTheDocument();
    expect(within(card('Volume')).getByText('Partial data')).toBeInTheDocument();
  });

  it('LP14 a failed volume alerts in its card; the stream is unaffected', async () => {
    const s = await opened('{app="a"}');
    await s.logs[0]?.resolve(page(rowsOf(3), null));
    await s.volume[0]?.reject(new ApiError('unavailable', 'down'));
    const alert = await within(card('Volume')).findByRole('alert');
    expect(alert).toHaveTextContent(
      'The volume could not be loaded: PulsusDB is unavailable: down',
    );
    expect(lines()).toEqual(['line 0', 'line 1', 'line 2']);
    expect(within(card('Query')).queryByRole('alert')).toBeNull();
  });

  it('LP15 a window change aborts both; a late old page changes nothing', async () => {
    const s = await opened('{app="a"}');
    await waitFor(() => {
      expect(s.volume).toHaveLength(1);
    });
    fireEvent.keyDown(document.body, { key: ']', code: 'BracketRight' });
    await waitFor(() => {
      expect(s.logs).toHaveLength(2);
      expect(s.volume).toHaveLength(2);
    });
    expect(s.logs[0]?.signal?.aborted).toBe(true);
    expect(s.volume[0]?.signal?.aborted).toBe(true);
    await s.logs[1]?.resolve(
      page(
        rowsOf(2, (i) => `new ${String(i)}`),
        null,
      ),
    );
    await s.logs[0]?.resolve(
      page(
        rowsOf(2, (i) => `old ${String(i)}`),
        null,
      ),
    );
    await waitFor(() => {
      expect(lines()).toEqual(['new 0', 'new 1']);
    });
  });

  it('LP16 a resize within one step makes no request; to another step, one of each', async () => {
    const s = await opened('{app="a"}');
    await waitFor(() => {
      expect(s.volume).toHaveLength(1);
    });
    resizeColumn(1000);
    await flush();
    expect(s.logs).toHaveLength(1);
    expect(s.volume).toHaveLength(1);
    resizeColumn(600);
    await waitFor(() => {
      expect(s.logs).toHaveLength(2);
      expect(s.volume).toHaveLength(2);
    });
    expect(s.logs[1]?.req.widthPx).toBe(600);
    expect(s.volume[1]?.req.widthPx).toBe(600);
  });

  it('LP17 a tenant switch aborts the old pager; its volume is not carried over', async () => {
    const s = await opened('{app="a"}');
    await s.volume[0]?.resolve(volumeAnswer());
    expect(card('Volume').querySelector('[data-chart-frame]')).not.toBeNull();
    await act(async () => {
      await s.router.navigate(logsUrl('{app="a"}', '', 'sandbox'));
    });
    await sized();
    await waitFor(() => {
      expect(s.logs.some((c) => c.tenant === 'sandbox')).toBe(true);
    });
    expect(s.logs[0]?.signal?.aborted).toBe(true);
    expect(card('Volume').querySelector('[data-chart-frame]')).toBeNull();
    const v = s.volume.find((c) => c.tenant === 'sandbox');
    await v?.resolve(volumeAnswer(['warn']));
    await waitFor(() => {
      expect(card('Volume').querySelector('[data-chart-frame]')).not.toBeNull();
    });
  });

  it('LP18 a URL query over 128 KB is refused without a request', async () => {
    const s = scriptedLogsPageApi();
    const big = `{a="${'x'.repeat(131_072)}"}`;
    openLogs(logsUrl(big), { api: s.api });
    await sized();
    await waitFor(() => {
      expect(within(card('Query')).getByRole('alert')).toHaveTextContent(QUERY_TOO_LARGE);
    });
    await flush();
    expect(s.logs).toHaveLength(0);
    expect(s.volume).toHaveLength(0);
  });

  it('LP19 drift: Run again makes one new page request and no volume request', async () => {
    const start = vi.spyOn(LogPager.prototype, 'start');
    const s = await opened('{app="a"}');
    await waitFor(() => {
      expect(s.volume).toHaveLength(1);
    });
    const pager = start.mock.contexts[0] as LogPager;
    // A two-entry buffer: page one is evicted once page two arrives, then re-fetched.
    Reflect.set(pager.buffer, 'capEntries', 2);
    await s.logs[0]?.resolve(
      page(
        rowsOf(2, (i) => `a${String(i)}`),
        'k1',
      ),
    );
    await waitFor(() => {
      expect(s.logs).toHaveLength(2);
    });
    pager.protect(null);
    await s.logs[1]?.resolve(
      page(
        rowsOf(2, (i) => `b${String(i)}`),
        null,
      ),
    );
    expect(pager.buffer.headPage).toBe(1);
    fireEvent.click(await screen.findByRole('button', { name: 'Load earlier lines' }));
    await waitFor(() => {
      expect(s.logs).toHaveLength(3);
    });
    expect(s.logs[2]?.req.cursor).toBeUndefined();
    // The re-fetch of page one answers other lines: drift.
    await s.logs[2]?.resolve(
      page(
        rowsOf(2, (i) => `x${String(i)}`),
        'k1',
      ),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Run again' }));
    await waitFor(() => {
      expect(s.logs).toHaveLength(4);
    });
    expect(s.logs[3]?.req.cursor).toBeUndefined();
    await flush();
    expect(s.logs).toHaveLength(4);
    expect(s.volume).toHaveLength(1);
  });

  it('LP21 a rerun after a series answer keeps Result and its series, with the shimmer', async () => {
    const s = await opened('sum(count_over_time({app="a"}[1m]))');
    const S = seriesAnswer([1, 2]);
    await s.logs[0]?.resolve(S);
    await screen.findByRole('heading', { level: 2, name: 'Result' });
    fireEvent.click(runButton());
    await waitFor(() => {
      expect(s.logs).toHaveLength(2);
    });
    expect(screen.getByRole('heading', { level: 2, name: 'Result' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 2, name: 'Log lines' })).toBeNull();
    const data = lastData(s.engine);
    expect(data?.kind === 'series' ? data.series : null).toBe(S.series);
    const host = (): Element | null =>
      card('Result').querySelector('[data-chart-frame]')?.closest('[aria-busy]') ?? null;
    await waitFor(
      () => {
        expect(host()).toHaveAttribute('aria-busy', 'true');
      },
      { timeout: 2000 },
    );
    const S2 = seriesAnswer([3, 4]);
    await s.logs[1]?.resolve(S2);
    await waitFor(() => {
      const d = lastData(s.engine);
      expect(d?.kind === 'series' ? d.series : null).toBe(S2.series);
    });
    expect(host()).toHaveAttribute('aria-busy', 'false');
  });

  it('LP22 a failed rerun after a series answer keeps Result and its series, no shimmer', async () => {
    const s = await opened('sum(count_over_time({app="a"}[1m]))');
    const S = seriesAnswer([1, 2]);
    await s.logs[0]?.resolve(S);
    await screen.findByRole('heading', { level: 2, name: 'Result' });
    fireEvent.click(runButton());
    await waitFor(() => {
      expect(s.logs).toHaveLength(2);
    });
    await s.logs[1]?.reject(new ApiError('unavailable', 'down'));
    expect(screen.getByRole('heading', { level: 2, name: 'Result' })).toBeInTheDocument();
    const data = lastData(s.engine);
    expect(data?.kind === 'series' ? data.series : null).toBe(S.series);
    expect(card('Result').querySelector('[aria-busy="true"]')).toBeNull();
    expect(within(card('Query')).getByRole('alert')).toHaveTextContent(
      'PulsusDB is unavailable: down',
    );
  });

  it('LP23 a tenant switch never shows the old tenant series', async () => {
    const q = 'sum(count_over_time({app="a"}[1m]))';
    const s = await opened(q);
    await s.logs[0]?.resolve(seriesAnswer([1, 2]));
    await screen.findByRole('heading', { level: 2, name: 'Result' });
    expect(frames()).toHaveLength(1);
    await act(async () => {
      await s.router.navigate(logsUrl(q, '', 'sandbox'));
    });
    expect(screen.queryByRole('heading', { level: 2, name: 'Result' })).toBeNull();
    expect(frames()).toHaveLength(0);
    await sized();
    await waitFor(() => {
      expect(s.logs.some((c) => c.tenant === 'sandbox')).toBe(true);
    });
    expect(screen.getByRole('heading', { level: 2, name: 'Log lines' })).toBeInTheDocument();
    const other = s.logs.find((c) => c.tenant === 'sandbox');
    const S2 = seriesAnswer([7, 8]);
    await other?.resolve(S2);
    await screen.findByRole('heading', { level: 2, name: 'Result' });
    const d = lastData(s.engine);
    expect(d?.kind === 'series' ? d.series : null).toBe(S2.series);
  });
});
