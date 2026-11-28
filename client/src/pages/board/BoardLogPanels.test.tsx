/**
 * unit:board-log-panels (plan #67 §5.2): board LogQL panels. A stream panel (Auto, Logs) pages
 * its lines through a `LogPager` while it is visible; a frame panel (Bars, Line, Heatmap, Stat)
 * sends a kind probe and, for Bars, the volume, under the panel key.
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type PanelSpec } from '../../api/types';
import { VOLUME_STACK } from '../../explore/logsRun';
import { resetQueryLanguages } from '../../boards/useQueryLanguage';
import { LogBuffer } from '../../logs/logBuffer';
import {
  ABS_SEARCH,
  editorOn,
  flush,
  frameOf,
  hide,
  holdRange,
  lastData,
  preview,
  ready,
  runKeys,
  settled,
  show,
  T12,
  T13,
  typeQuery,
  windowKey,
} from '../../test/boardPanelKit';
import {
  aborted,
  installLogLayout,
  level,
  lines,
  logPanel,
  metric,
  openLogBoard,
  vol,
  type LogBoard,
} from '../../test/boardLogKit';
import { panel, panelOf, panelState } from '../../test/boardTestKit';
import { fakeEditorSource } from '../../test/fakeEditor';
import {
  installIntersectionObserver,
  uninstallIntersectionObserver,
} from '../../test/fakeIntersectionObserver';
import { F } from '../../test/fakePromSource';
import { installResizeObserver, resizeAll } from '../../test/fakeResizeObserver';

vi.mock('../../editor/editor', () => import('../../test/fakeEditor'));
vi.mock('../../editor/logqlEditor', () => import('../../test/fakeLogqlEditor'));

/** The LogQL language imports (BL22). */
const langs = vi.hoisted(() => ({ logql: 0 }));
vi.mock('../../editor/lang/index', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../editor/lang/index')>();
  return {
    ...m,
    LANGUAGES: Object.freeze({
      ...m.LANGUAGES,
      logql: () => {
        langs.logql += 1;
        return m.LANGUAGES.logql();
      },
    }),
  };
});

const S = logPanel('p-1', 'S', '{app="a"}');
const V = logPanel('p-2', 'V', '{app="a"}', 'bars');
const P: PanelSpec = { ...panel('p-3', 'P', 'up', 'line') };
const Q = '{app="a"}';

let restoreLayout: () => void = () => undefined;
beforeEach(() => {
  installResizeObserver();
  installIntersectionObserver();
  resetQueryLanguages();
  fakeEditorSource.data = F;
  langs.logql = 0;
  restoreLayout = installLogLayout();
});

afterEach(() => {
  restoreLayout();
  vi.restoreAllMocks();
  uninstallIntersectionObserver();
});

async function open(panels: readonly PanelSpec[], extra = ''): Promise<LogBoard> {
  const t = openLogBoard(panels, { extra });
  await ready(...panels.map((p) => p.title));
  return t;
}

const list = (title: string) =>
  within(panelOf(title)).getByRole('list', { name: `Log lines: ${title}` });

async function streamShows(title: string, line: string): Promise<void> {
  await waitFor(() => {
    expect(panelState(title)).toBe('stream');
  });
  await waitFor(() => {
    expect(within(list(title)).getByText(line)).toBeInTheDocument();
  });
}

function search(t: LogBoard): URLSearchParams {
  return new URLSearchParams(t.router.state.location.search);
}

describe('unit:board-log-panels', () => {
  it('BL1 a visible stream panel: one first page', async () => {
    const t = await open([S]);
    show('S');
    await waitFor(() => {
      expect(t.logs).toHaveLength(1);
    });
    expect(t.logs[0]?.req).toEqual({
      query: Q,
      fromMs: T12,
      toMs: T13,
      widthPx: 1000,
      direction: 'backward',
      limit: 1000,
      vars: {},
    });
    expect(t.logs[0]?.req).not.toHaveProperty('cursor');
    await t.logs[0]?.resolve(lines(3));
    await streamShows('S', 'p0r0');
    expect(within(list('S')).getByText('p0r2')).toBeInTheDocument();
    expect(t.queryVolume).not.toHaveBeenCalled();
  });

  it('BL2 visible only; the pager is kept while scrolled out', async () => {
    const t = await open([S]);
    await flush();
    expect(t.logs).toHaveLength(0);
    show('S');
    await waitFor(() => {
      expect(t.logs).toHaveLength(1);
    });
    hide('S');
    await flush();
    expect(t.logs).toHaveLength(1);
    show('S');
    await flush();
    expect(t.logs).toHaveLength(1);
    expect(aborted(t.logs[0])).toBe(false);
  });

  it('BL3 a window change while hidden: none until shown, then one', async () => {
    const t = await open([S]);
    show('S');
    await waitFor(() => {
      expect(t.logs).toHaveLength(1);
    });
    await t.logs[0]?.resolve(lines(3));
    hide('S');
    windowKey(']');
    await flush();
    expect(t.logs).toHaveLength(1);
    show('S');
    await waitFor(() => {
      expect(t.logs).toHaveLength(2);
    });
    expect(t.logs[1]?.req.fromMs).toBeGreaterThan(T12);
    await flush();
    expect(t.logs).toHaveLength(2);
  });

  it('BL4 a bars panel: one probe and one volume', async () => {
    const t = await open([V]);
    show('V');
    await waitFor(() => {
      expect(t.logs).toHaveLength(1);
      expect(t.volume).toHaveLength(1);
    });
    const body = { query: Q, fromMs: T12, toMs: T13, widthPx: 1000, vars: {} };
    expect(t.logs[0]?.req).toEqual({ ...body, limit: 1 });
    expect(t.volume[0]?.req).toEqual(body);
    await t.logs[0]?.resolve(lines(1));
    await t.volume[0]?.resolve(vol());
    await waitFor(() => {
      expect(panelOf('V')).toHaveAttribute('data-panel-vis', 'bars');
    });
  });

  it('BL5 a bars panel on a metric query: the volume aborts; bars of the series', async () => {
    const t = await open([V]);
    show('V');
    await waitFor(() => {
      expect(t.volume).toHaveLength(1);
    });
    await t.logs[0]?.resolve(metric(['a', 'b']));
    expect(aborted(t.volume[0])).toBe(true);
    await settled(t, 'V');
    expect(panelOf('V')).toHaveAttribute('data-panel-vis', 'bars');
    const d = lastData(t, 'V');
    expect(d?.kind === 'series' ? d.series.map((s) => s.labels['app']) : null).toEqual(['a', 'b']);
  });

  it('BL6 a stream panel on a metric query: Auto draws a line; Logs says why not', async () => {
    const L = logPanel('p-2', 'L', 'rate({app="a"}[1m])', 'logs');
    const t = await open([{ ...S, query: { lang: 'logql', text: 'rate({app="a"}[1m])' } }, L]);
    show('S', 'L');
    await waitFor(() => {
      expect(t.logs).toHaveLength(2);
    });
    for (const c of t.logs) await c.resolve(metric());
    await waitFor(() => {
      expect(panelOf('S')).toHaveAttribute('data-panel-vis', 'line');
    });
    expect(
      within(panelOf('L')).getByText('A metric query has no log lines. Choose Auto or a chart.'),
    ).toBeInTheDocument();
  });

  it('BL7 a line panel on a log query: a message, no volume', async () => {
    const t = await open([logPanel('p-1', 'Ln', Q, 'line')]);
    show('Ln');
    await waitFor(() => {
      expect(t.logs).toHaveLength(1);
    });
    expect(t.logs[0]?.req.limit).toBe(1);
    await t.logs[0]?.resolve(lines(1));
    expect(
      await within(panelOf('Ln')).findByText(
        'Line, Heatmap and Stat draw metric queries. Choose Auto, Logs or Bars for log lines.',
      ),
    ).toBeInTheDocument();
    expect(panelState('Ln')).toBe('notMetric');
    expect(t.queryVolume).not.toHaveBeenCalled();
  });

  it('BL8 a window change aborts every request in flight; one each after', async () => {
    const t = await open([S, V, P]);
    const h = holdRange(t);
    show('S', 'V', 'P');
    await waitFor(() => {
      expect(t.pages()).toHaveLength(1);
      expect(t.probes()).toHaveLength(1);
      expect(t.volume).toHaveLength(1);
      expect(h.held).toHaveLength(1);
    });
    windowKey(']');
    await waitFor(() => {
      expect(t.pages()).toHaveLength(2);
    });
    expect(aborted(t.pages()[0])).toBe(true);
    expect(aborted(t.probes()[0])).toBe(true);
    expect(aborted(t.volume[0])).toBe(true);
    expect(h.held[0]?.signal?.aborted).toBe(true);
    await waitFor(() => {
      expect(t.probes()).toHaveLength(2);
      expect(t.volume).toHaveLength(2);
      expect(h.held).toHaveLength(2);
    });
    await flush();
    expect([t.pages().length, t.probes().length, t.volume.length, h.held.length]).toEqual([
      2, 2, 2, 2,
    ]);
  });

  it('BL9 Refresh now under an absolute window: one of each again', async () => {
    const t = await open([S, V, P]);
    show('S', 'V', 'P');
    await waitFor(() => {
      expect(t.pages()).toHaveLength(1);
      expect(t.probes()).toHaveLength(1);
      expect(t.range).toHaveBeenCalledTimes(1);
    });
    await t.pages()[0]?.resolve(lines(3));
    await t.probes()[0]?.resolve(lines(1));
    await t.volume[0]?.resolve(vol());
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh now' }));
    await waitFor(() => {
      expect(t.pages()).toHaveLength(2);
      expect(t.probes()).toHaveLength(2);
      expect(t.volume).toHaveLength(2);
      expect(t.range).toHaveBeenCalledTimes(2);
    });
    expect(t.pages()[1]?.req).not.toHaveProperty('cursor');
    expect([t.pages()[1]?.req.fromMs, t.pages()[1]?.req.toMs]).toEqual([T12, T13]);
    await flush();
    expect([t.pages().length, t.probes().length, t.volume.length]).toEqual([2, 2, 2]);
  });

  it('BL10 an unset variable: the message, then the raw text with vars', async () => {
    const t = await open([logPanel('p-1', 'Var', '{app="$app"}')]);
    show('Var');
    expect(
      await within(panelOf('Var')).findByText('Set a value for $app to run this panel'),
    ).toBeInTheDocument();
    await flush();
    expect(t.logs).toHaveLength(0);
    await act(async () => {
      await t.router.navigate(`/t/demo/board/b-1${ABS_SEARCH}&var-app=x`);
    });
    await waitFor(() => {
      expect(t.logs).toHaveLength(1);
    });
    expect(t.logs[0]?.req).toMatchObject({ query: '{app="$app"}', vars: { app: 'x' } });
  });

  it('BL11 a first page rejected at a position: the panel error with line and column', async () => {
    const t = await open([S]);
    show('S');
    await waitFor(() => {
      expect(t.logs).toHaveLength(1);
    });
    await t.logs[0]?.reject(new ApiError('queryInvalid', 'bad', { detail: { position: 8 } }));
    await waitFor(() => {
      expect(within(panelOf('S')).getByRole('alert').textContent).toMatch(/\(line 1, column 9\)$/);
    });
    expect(panelState('S')).toBe('error');
  });

  it('BL12 truncated: Partial data; Narrow makes one call on the middle half', async () => {
    const t = await open([S]);
    show('S');
    await waitFor(() => {
      expect(t.logs).toHaveLength(1);
    });
    await t.logs[0]?.resolve(lines(3, { truncated: true }));
    const badge = await screen.findByRole('button', { name: 'Partial data: S' });
    await t.user.click(badge);
    const notices = await screen.findByRole('status', { name: 'Query notices' });
    await t.user.click(within(notices).getByRole('button', { name: 'Narrow the time range' }));
    await waitFor(() => {
      expect([search(t).get('from'), search(t).get('to')]).toEqual([
        '2026-11-19T12:15:00.000Z',
        '2026-11-19T12:45:00.000Z',
      ]);
    });
    await waitFor(() => {
      expect(t.logs).toHaveLength(2);
    });
    expect([t.logs[1]?.req.fromMs, t.logs[1]?.req.toMs]).toEqual([
      T12 + 15 * 60_000,
      T12 + 45 * 60_000,
    ]);
    await flush();
    expect(t.logs).toHaveLength(2);
  });

  it('BL13 a resize within the step sends nothing; another step one', async () => {
    const t = await open([S]);
    show('S');
    await waitFor(() => {
      expect(t.logs).toHaveLength(1);
    });
    act(() => {
      resizeAll(1010, 240);
    });
    await flush();
    expect(t.logs).toHaveLength(1);
    act(() => {
      resizeAll(500, 240);
    });
    await waitFor(() => {
      expect(t.logs).toHaveLength(2);
    });
    expect(t.logs[1]?.req.widthPx).toBe(500);
    expect(aborted(t.logs[0])).toBe(true);
  });

  it('BL14 a tenant switch aborts both panels', async () => {
    const t = await open([S, V]);
    show('S', 'V');
    await waitFor(() => {
      expect(t.pages()).toHaveLength(1);
      expect(t.probes()).toHaveLength(1);
      expect(t.volume).toHaveLength(1);
    });
    await act(async () => {
      await t.router.navigate(`/t/sandbox/board/b-1${ABS_SEARCH}`);
    });
    await waitFor(() => {
      expect(aborted(t.pages()[0])).toBe(true);
      expect(aborted(t.probes()[0])).toBe(true);
      expect(aborted(t.volume[0])).toBe(true);
    });
    for (const c of [...t.logs, ...t.volume].filter((x) => !aborted(x))) {
      expect(c.tenant).toBe('sandbox');
    }
  });

  it('BL15 drift: Run again is one new first page', async () => {
    const t = await open([S]);
    show('S');
    await waitFor(() => {
      expect(t.logs).toHaveLength(1);
    });
    await t.logs[0]?.resolve(lines(3, { cursor: 'c1' }));
    await waitFor(() => {
      expect(t.logs).toHaveLength(2);
    });
    expect(t.logs[1]?.req.cursor).toBe('c1');
    vi.spyOn(LogBuffer.prototype, 'accept').mockReturnValueOnce('drift');
    await t.logs[1]?.resolve(lines(3, { cursor: 'c2' }));
    const again = await within(panelOf('S')).findByRole('button', { name: 'Run again' });
    fireEvent.click(again);
    await waitFor(() => {
      expect(t.logs).toHaveLength(3);
    });
    expect(t.logs[2]?.req).not.toHaveProperty('cursor');
    await flush();
    expect(t.logs).toHaveLength(3);
  });

  it('BL16 Open in Explore waits for the answer, then links its expanded text', async () => {
    const t = await open([S]);
    show('S');
    await waitFor(() => {
      expect(t.logs).toHaveLength(1);
    });
    expect(screen.getByRole('button', { name: 'Open in Explore: S' })).toBeDisabled();
    await t.logs[0]?.resolve(lines(3));
    const link = await screen.findByRole('link', { name: 'Open in Explore: S' });
    expect(link).toHaveAttribute('href', `/t/demo/explore/logs${ABS_SEARCH}&q=%7Bapp%3D%22a%22%7D`);
  });

  it('BL17 full screen shows the same pager; the panel body yields', async () => {
    const t = await open([S]);
    show('S');
    await waitFor(() => {
      expect(t.logs).toHaveLength(1);
    });
    await t.logs[0]?.resolve(lines(3));
    await streamShows('S', 'p0r0');
    await t.user.click(screen.getByRole('button', { name: 'Full screen: S' }));
    const d = await screen.findByRole('dialog', { name: 'S' });
    expect(within(d).getByRole('list', { name: 'Log lines: S' })).toBeInTheDocument();
    expect(within(d).getByText('p0r0')).toBeInTheDocument();
    expect(within(panelOf('S')).getByText('Shown at full screen')).toBeInTheDocument();
    expect(within(panelOf('S')).queryByRole('list', { hidden: true })).toBeNull();
    await flush();
    expect(t.logs).toHaveLength(1);
  });

  it('BL18 order is a new run; wrap is not', async () => {
    const t = await open([S]);
    show('S');
    await waitFor(() => {
      expect(t.logs).toHaveLength(1);
    });
    await t.logs[0]?.resolve(lines(3));
    await streamShows('S', 'p0r0');
    await t.user.click(within(panelOf('S')).getByRole('radio', { name: 'Oldest first' }));
    await waitFor(() => {
      expect(t.logs).toHaveLength(2);
    });
    expect(t.logs[1]?.req.direction).toBe('forward');
    await t.logs[1]?.resolve(lines(3));
    await streamShows('S', 'p0r0');
    await t.user.click(within(panelOf('S')).getByRole('checkbox', { name: 'Wrap lines' }));
    await flush();
    expect(t.logs).toHaveLength(2);
    expect(within(panelOf('S')).getByRole('checkbox', { name: 'Wrap lines' })).toBeChecked();
  });

  it('BL19 a PromQL panel edited to LogQL: the preview runs; the panel after Done', async () => {
    const t = await open([panel('p-1', 'Pq', 'up')]);
    show('Pq');
    await waitFor(() => {
      expect(t.range).toHaveBeenCalledTimes(1);
    });
    const d = await editorOn(t, 'Pq');
    await t.user.click(within(d).getByRole('button', { name: /Query language$/ }));
    await t.user.click(await screen.findByRole('option', { name: 'LogQL' }));
    const field = await within(d).findByRole('textbox', { name: 'Query' });
    await waitFor(() => {
      expect(field.closest('[data-editor-host]')).not.toBeNull();
    });
    typeQuery(d, Q);
    runKeys(d);
    const ofQ = () => t.logs.filter((c) => c.req.query === Q);
    await waitFor(() => {
      expect(ofQ()).toHaveLength(1);
    });
    await ofQ()[0]?.resolve(lines(3));
    await waitFor(() => {
      expect(preview(d)).toHaveAttribute('data-panel-state', 'stream');
    });
    await flush();
    expect(ofQ()).toHaveLength(1);
    await t.user.click(within(d).getByRole('button', { name: 'Done' }));
    await waitFor(() => {
      expect(ofQ()).toHaveLength(2);
    });
    await flush();
    expect(ofQ()).toHaveLength(2);
  });

  it('BL20 Run with the same text: one new call each, the last aborted', async () => {
    const t = await open([S]);
    show('S');
    await waitFor(() => {
      expect(t.logs).toHaveLength(1);
    });
    await t.logs[0]?.resolve(lines(3));
    const d = await editorOn(t, 'S');
    await waitFor(() => {
      expect(t.logs).toHaveLength(2);
    });
    for (const n of [3, 4]) {
      runKeys(d);
      await waitFor(() => {
        expect(t.logs).toHaveLength(n);
      });
      expect(aborted(t.logs[n - 2])).toBe(true);
      await flush();
      expect(t.logs).toHaveLength(n);
    }
  });

  it('BL21 the Auto option names what the preview answer draws', async () => {
    const t = await open([S, logPanel('p-2', 'M', 'rate({app="a"}[1m])')]);
    show('S', 'M');
    await waitFor(() => {
      expect(t.logs).toHaveLength(2);
    });
    const vis = (d: HTMLElement) => within(d).getByRole('button', { name: /Visualisation$/ });
    const d = await editorOn(t, 'S');
    await waitFor(() => {
      expect(t.logs).toHaveLength(3);
    });
    await t.logs[2]?.resolve(lines(3));
    await waitFor(() => {
      expect(vis(d)).toHaveTextContent('Auto (Logs)');
    });
    await t.user.click(within(d).getByRole('button', { name: 'Done' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    const m = await editorOn(t, 'M');
    const call = await waitFor(() => {
      const c = t.logs.find((x) => x.req.query.startsWith('rate') && !aborted(x));
      if (c === undefined) throw new Error('no preview call');
      return c;
    });
    await call.resolve(metric());
    await waitFor(() => {
      expect(vis(m)).toHaveTextContent('Auto (Line)');
    });
  });

  it('BL22 a PromQL-only board loads no LogQL', async () => {
    const t = await open([P]);
    show('P');
    await waitFor(() => {
      expect(t.range).toHaveBeenCalledTimes(1);
    });
    await flush();
    expect(langs.logql).toBe(0);
  });

  it('BL23 the saved vis kinds survive a save and a reload', async () => {
    const Pa = panel('p-3', 'Pa', 'up');
    const t = await open([{ ...V, vis: { kind: 'auto' } }, Pa]);
    const d = await editorOn(t, 'V');
    await t.user.click(within(d).getByRole('button', { name: /Visualisation$/ }));
    await t.user.click(await screen.findByRole('option', { name: 'Bars' }));
    await t.user.click(within(d).getByRole('button', { name: 'Done' }));
    await t.user.click(await screen.findByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(screen.getByRole('status', { name: 'Save status' })).toHaveTextContent('Saved');
    });
    cleanup();
    openLogBoard([], { api: t.api });
    await ready('V', 'Pa');
    expect(panelOf('V')).toHaveAttribute('data-vis', 'bars');
    expect(panelOf('Pa')).toHaveAttribute('data-vis', 'auto');
  });

  it('BL24 Edit aborts the panel page in flight; the preview runs; Done runs the panel', async () => {
    const t = await open([S]);
    show('S');
    await waitFor(() => {
      expect(t.logs).toHaveLength(1);
    });
    await editorOn(t, 'S');
    await waitFor(() => {
      expect(t.logs).toHaveLength(2);
    });
    expect(aborted(t.logs[0])).toBe(true);
    await flush();
    expect(t.logs).toHaveLength(2);
    await t.user.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => {
      expect(t.logs).toHaveLength(3);
    });
    expect(aborted(t.logs[1])).toBe(true);
    await flush();
    expect(t.logs).toHaveLength(3);
  });

  it('BL25 a stream panel on a metric answer: its expanded text and Partial data', async () => {
    const E = 'rate({app="a"}[1m])';
    const t = await open([logPanel('p-1', 'R', 'rate({app="$a"}[1m])')], '&var-a=a');
    show('R');
    await waitFor(() => {
      expect(t.logs).toHaveLength(1);
    });
    await t.logs[0]?.resolve(metric(['a'], { truncated: true, q: E }));
    expect(await screen.findByRole('button', { name: 'Partial data: R' })).toBeInTheDocument();
    const link = await screen.findByRole('link', { name: 'Open in Explore: R' });
    expect(new URL(link.getAttribute('href') ?? '', 'http://x').searchParams.get('q')).toBe(E);
  });

  it('BL26 the volume legend isolates a level locally', async () => {
    const t = await open([V]);
    show('V');
    await waitFor(() => {
      expect(t.volume).toHaveLength(1);
    });
    await t.logs[0]?.resolve(lines(1));
    await t.volume[0]?.resolve(vol());
    await settled(t, 'V');
    const spec = () => frameOf(t, 'V')?.last('setSpec')?.[0] as Record<string, unknown>;
    const count = () => {
      const d = lastData(t, 'V');
      return d?.kind === 'series' ? d.series.length : -1;
    };
    expect(count()).toBe(2);
    const legend = panelOf('V').querySelector<HTMLElement>('[data-panel-legend="table"]');
    if (legend === null) throw new Error('no legend');
    const row = within(legend).getByRole('button', { name: '{level="error"}' });
    await t.user.click(row);
    await waitFor(() => {
      expect(count()).toBe(1);
    });
    expect(spec()).toMatchObject({
      kind: 'bars',
      categoryLabel: 'level',
      categoryOrder: VOLUME_STACK,
      unit: { kind: 'suffix', suffix: 'lines' },
    });
    const d = lastData(t, 'V');
    expect(d?.kind === 'series' ? d.series : null).toEqual([level('error', 3)]);
    await t.user.click(within(legend).getByRole('button', { name: '{level="error"}' }));
    await waitFor(() => {
      expect(count()).toBe(2);
    });
    expect(t.volume).toHaveLength(1);
  });

  it('BL27 a rejected probe aborts its volume; the next window runs both once', async () => {
    const t = await open([V]);
    show('V');
    await waitFor(() => {
      expect(t.volume).toHaveLength(1);
    });
    await t.logs[0]?.reject(new ApiError('timeout', 'timed out'));
    expect(aborted(t.volume[0])).toBe(true);
    windowKey(']');
    await waitFor(() => {
      expect(t.logs).toHaveLength(2);
      expect(t.volume).toHaveLength(2);
    });
    await flush();
    expect([t.logs.length, t.volume.length]).toEqual([2, 2]);
  });

  it('BL28 only a referenced variable re-keys a bars panel', async () => {
    const t = await open([logPanel('p-1', 'Vv', '{app="$app"}', 'bars')], '&var-app=x&var-env=p');
    show('Vv');
    await waitFor(() => {
      expect(t.volume).toHaveLength(1);
    });
    await t.logs[0]?.resolve(lines(1));
    await t.volume[0]?.resolve(vol());
    const at = (q: string) =>
      act(async () => {
        await t.router.navigate(`/t/demo/board/b-1${ABS_SEARCH}${q}`);
      });
    await at('&var-app=x&var-env=q');
    await flush();
    expect([t.logs.length, t.volume.length]).toEqual([1, 1]);
    await at('&var-app=y&var-env=q');
    await waitFor(() => {
      expect([t.logs.length, t.volume.length]).toEqual([2, 2]);
    });
    expect(t.logs[1]?.req.vars).toEqual({ app: 'y' });
    expect(t.volume[1]?.req.vars).toEqual({ app: 'y' });
  });

  it('BL29 a window away and back while hidden: one when shown', async () => {
    const t = await open([S]);
    show('S');
    await waitFor(() => {
      expect(t.logs).toHaveLength(1);
    });
    await t.logs[0]?.resolve(lines(3));
    hide('S');
    windowKey('[');
    await flush();
    windowKey(']');
    await flush();
    expect(t.logs).toHaveLength(1);
    show('S');
    await waitFor(() => {
      expect(t.logs).toHaveLength(2);
    });
    expect([t.logs[1]?.req.fromMs, t.logs[1]?.req.toMs]).toEqual([T12, T13]);
    await flush();
    expect(t.logs).toHaveLength(2);
  });
});
