import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { useContext, useState } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StubApi } from '../api/StubApi';
import {
  ApiError,
  type BoardSpec,
  type BoardVariable,
  type DataPanelSpec,
  type RangeRequest,
} from '../api/types';
import { Providers } from '../app/providers';
import type { RangeResult } from '../data/decode';
import { ChartEngineContext } from '../engine/index';
import { PanelBody } from '../pages/board/PanelFrame';
import { createClock } from '../state/clock';
import { fakeEngine } from '../test/fakeEngine';
import { installResizeObserver, resizeAll } from '../test/fakeResizeObserver';
import { BY_VERSION_Q, rangeByVersion } from '../test/rangeFixtures';
import { T } from '../test/renderApp';
import { renderRouted } from '../test/routedHarness';
import { panelOf, stubBoard } from '../test/boardTestKit';
import { ABS as ABS_Q, flush, openBoard, ready, show } from '../test/boardPanelKit';
import {
  installIntersectionObserver,
  uninstallIntersectionObserver,
} from '../test/fakeIntersectionObserver';
import { seedWith } from '../test/seeds';
import { BoardRunContext, BoardRunProvider } from './boardRun';
import { panelView } from './panelRun';
import type { WidthStore } from './panelWidths';
import { usePanelRun, type PanelRun } from './usePanelRun';

describe('epoch mark', () => {
  it('epoch mark', async () => {
    const queryClient = new QueryClient();
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    let setReady: (v: boolean) => void = () => undefined;
    let rerender: () => void = () => undefined;
    function Host() {
      const [ready, set] = useState(false);
      const [, bump] = useState(0);
      setReady = set;
      rerender = () => {
        bump((n) => n + 1);
      };
      return (
        <BoardRunProvider tenant="demo" vars={new Map()} timeReady={ready}>
          <p>child</p>
        </BoardRunProvider>
      );
    }
    const { router } = renderRouted(<Host />, {
      url: '/?from=2026-11-19T12:00:00.000Z&to=2026-11-19T13:00:00.000Z&refresh=off',
      queryClient,
    });
    await screen.findByText('child');
    expect(spy).not.toHaveBeenCalled();
    act(() => {
      setReady(true);
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenLastCalledWith({
      queryKey: ['data', 'panel', 'demo'],
      refetchType: 'none',
    });
    await act(async () => {
      await router.navigate(
        '/?from=2026-11-19T13:00:00.000Z&to=2026-11-19T14:00:00.000Z&refresh=off',
      );
    });
    expect(spy).toHaveBeenCalledTimes(2);
    act(() => {
      rerender();
    });
    await act(async () => {
      await router.navigate(
        '/?from=2026-11-19T13:00:00.000Z&to=2026-11-19T14:00:00.000Z&refresh=10s',
      );
    });
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('panel widths (review r1 #3)', () => {
  it("a reused panel id does not inherit a deleted panel's width", async () => {
    let widths: WidthStore | null = null;
    let setLive: (ids: string[]) => void = () => undefined;
    function Probe() {
      widths = useContext(BoardRunContext).widths;
      return <p>probe</p>;
    }
    function Host() {
      const [live, set] = useState<string[]>(['p-1', 'p-2']);
      setLive = set;
      return (
        <BoardRunProvider tenant="demo" vars={new Map()} timeReady livePanels={live}>
          <Probe />
        </BoardRunProvider>
      );
    }
    renderRouted(<Host />, { url: '/?from=now-1h&to=now&refresh=off' });
    await screen.findByText('probe');
    act(() => {
      widths?.set('p-1', 400);
      widths?.set('p-2', 700);
    });
    // p-2 is deleted, then a new panel takes its id.
    act(() => {
      setLive(['p-1']);
    });
    act(() => {
      setLive(['p-1', 'p-2']);
    });
    const w = widths as WidthStore | null;
    expect(w?.get('p-2')).toBeNull();
    expect(w?.get('p-1')).toBe(400);
  });
});

const DAY = 86_400_000;
const T12 = Date.UTC(2026, 10, 19, 12);
const T13 = Date.UTC(2026, 10, 19, 13);
const ABS = '/t/demo/x?from=2026-11-19T12:00:00.000Z&to=2026-11-19T13:00:00.000Z&refresh=off';

const barPanel = (vis: DataPanelSpec['vis'] = { kind: 'barchart' }): DataPanelSpec => ({
  id: 'p-1',
  title: 'Versions',
  grid: { x: 0, y: 0, w: 6, h: 6 },
  query: { lang: 'promql', text: BY_VERSION_Q },
  vis,
});

interface Call {
  readonly req: RangeRequest;
  readonly signal: AbortSignal | undefined;
  resolve(r: RangeResult): void;
  reject(e: unknown): void;
}

/**
 * One `usePanelRun` (plan #173 Part 3b §4.2) on a stub whose range calls the test settles, with
 * the panel body of its view (the bar chart with the ghost, the note).
 */
function mountRun(panel: DataPanelSpec, ghost: boolean) {
  installResizeObserver();
  const api = new StubApi();
  const calls: Call[] = [];
  const range = vi.spyOn(api, 'queryRange').mockImplementation(
    (_tenant, req, signal) =>
      new Promise<RangeResult>((resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
        calls.push({ req, signal, resolve, reject });
      }),
  );
  const latest: { run: PanelRun | null } = { run: null };
  let setProps: (p: { panel: DataPanelSpec; ghost: boolean }) => void = () => undefined;
  function Run() {
    const [p, set] = useState({ panel, ghost });
    setProps = set;
    const run = usePanelRun({
      tenant: 'demo',
      panel: p.panel,
      text: p.panel.query.text,
      enabled: true,
      widthPx: 1000,
      ghost: p.ghost,
    });
    latest.run = run;
    const view = panelView(run, p.panel.vis, 'Versions');
    return (
      <div data-view={view.kind}>
        <PanelBody
          title="Versions"
          view={view}
          onNarrow={() => undefined}
          category={{
            ghost: p.ghost,
            anomaly: false,
            table: false,
            onTable: () => undefined,
            origin: {
              surface: 'board',
              panelId: 'p-1',
              title: 'Versions',
              query: null,
              unit: null,
            },
          }}
        />
      </div>
    );
  }
  const engine = fakeEngine();
  const router = createMemoryRouter(
    [
      {
        path: '/t/:tenant/x',
        element: (
          <ChartEngineContext.Provider value={engine}>
            <BoardRunProvider tenant="demo" vars={new Map()} timeReady>
              <Run />
            </BoardRunProvider>
          </ChartEngineContext.Provider>
        ),
      },
    ],
    { initialEntries: [ABS] },
  );
  render(
    <Providers
      deps={{
        api,
        queryClient: new QueryClient(),
        clock: createClock(() => T),
        timeZone: 'Europe/London',
      }}
    >
      <RouterProvider router={router} />
    </Providers>,
  );
  const settle = async (c: Call | undefined, r: RangeResult | Error): Promise<void> => {
    await act(async () => {
      if (r instanceof Error) c?.reject(r);
      else c?.resolve(r);
      await Promise.resolve();
    });
  };
  return {
    api,
    range,
    calls,
    engine,
    router,
    latest,
    settle,
    set: (p: { panel: DataPanelSpec; ghost: boolean }) => {
      act(() => {
        setProps(p);
      });
    },
  };
}

const shifted = (c: Call | undefined) => [(c?.req.fromMs ?? 0) - T12, (c?.req.toMs ?? 0) - T13];

describe('unit:panel-run-baseline', () => {
  it('a baseline run only with an offset or the ghost, shifted by the offset', async () => {
    const off = mountRun(barPanel(), false);
    await waitFor(() => {
      expect(off.calls).toHaveLength(1);
    });
    expect(shifted(off.calls[0])).toEqual([0, 0]);
    off.set({ panel: barPanel(), ghost: true });
    await waitFor(() => {
      expect(off.calls).toHaveLength(3);
    });
    // The main request again (a new key), then the shifted one.
    expect(shifted(off.calls[1])).toEqual([0, 0]);
    expect(shifted(off.calls[2])).toEqual([-DAY, -DAY]);
    expect(off.calls[2]?.req.widthPx).toBe(off.calls[1]?.req.widthPx);
    await off.settle(off.calls[1], rangeByVersion());
    await off.settle(off.calls[2], rangeByVersion(0.5));
    await waitFor(() => {
      expect(off.latest.run?.outcome?.key[10]).toBe(DAY);
    });
    expect(off.latest.run?.outcome?.baseline).toMatchObject({ kind: 'series' });

    off.set({
      panel: barPanel({ kind: 'barchart', options: { baselineOffset: '7d' } }),
      ghost: false,
    });
    await waitFor(() => {
      expect(off.calls).toHaveLength(5);
    });
    expect(shifted(off.calls[4])).toEqual([-7 * DAY, -7 * DAY]);
  });

  it('a line panel with the ghost sends one request', async () => {
    const line = mountRun(barPanel({ kind: 'line' }), true);
    await waitFor(() => {
      expect(line.calls).toHaveLength(1);
    });
    await line.settle(line.calls[0], rangeByVersion());
    await waitFor(() => {
      expect(line.latest.run?.outcome).not.toBeNull();
    });
    expect(line.calls).toHaveLength(1);
    expect(line.latest.run?.outcome?.key[10]).toBeNull();
    expect(line.latest.run?.outcome?.baseline).toBeUndefined();
  });
});

describe('unit:panel-run-cancel', () => {
  it('(a) a failed main request aborts the baseline and shows its error; (d) a late baseline changes nothing', async () => {
    const m = mountRun(barPanel(), true);
    await waitFor(() => {
      expect(m.calls).toHaveLength(2);
    });
    const [main, base] = m.calls;
    await m.settle(main, new ApiError('unavailable', 'boom'));
    await waitFor(() => {
      expect(m.latest.run?.error).toBeInstanceOf(ApiError);
    });
    expect(base?.signal?.aborted).toBe(true);
    const before = m.latest.run;
    await m.settle(base, rangeByVersion(0.5));
    expect(m.latest.run?.error).toBe(before?.error);
    expect(m.latest.run?.outcome).toBeNull();
  });

  it('(b) a window change aborts both, shows no error, and runs the new key', async () => {
    const m = mountRun(barPanel(), true);
    await waitFor(() => {
      expect(m.calls).toHaveLength(2);
    });
    await act(async () => {
      await m.router.navigate(
        '/t/demo/x?from=2026-11-19T13:00:00.000Z&to=2026-11-19T14:00:00.000Z&refresh=off',
      );
    });
    await waitFor(() => {
      expect(m.calls).toHaveLength(4);
    });
    expect(m.calls[0]?.signal?.aborted).toBe(true);
    expect(m.calls[1]?.signal?.aborted).toBe(true);
    expect(m.latest.run?.error).toBeNull();
    expect(m.calls[2]?.req.fromMs).toBe(T13);
  });

  it('(c) a failed baseline keeps the main result: bars without a ghost, and the note', async () => {
    const m = mountRun(barPanel(), true);
    await waitFor(() => {
      expect(m.calls).toHaveLength(2);
    });
    const [main, base] = m.calls;
    await m.settle(base, new ApiError('unavailable', 'boom'));
    await m.settle(main, rangeByVersion());
    await waitFor(() => {
      expect(m.latest.run?.outcome?.baseline).toBe('failed');
    });
    expect(m.latest.run?.error).toBeNull();
    expect(document.querySelector('[data-view]')).toHaveAttribute('data-view', 'category');
    act(() => {
      resizeAll(600, 240);
    });
    await waitFor(() => {
      expect(m.engine.frames.at(-1)?.last('setSpec')?.[0]).toMatchObject({
        kind: 'barchart',
        ghost: false,
      });
    });
    expect(screen.getByText('Baseline unavailable: the shifted query failed.')).toBeInTheDocument();
  });
});

// The ClickHouse board of api/fixtures/board-spec/v9-variables.json (plan #289 §3.1).
const CLICKHOUSE = JSON.parse(
  readFileSync(
    join(process.cwd(), '..', 'api', 'fixtures', 'board-spec', 'v9-variables.json'),
    'utf8',
  ),
) as BoardSpec;
const NODE_PANELS = ['Uptime', 'Queries', 'Memory'];
const ALL_PANELS = [...NODE_PANELS, 'Scrape targets', 'Up'];

/** The vars of every range and instant request so far, by panel text. */
function sentVars(b: ReturnType<typeof openBoard>): { text: string; vars: unknown }[] {
  return [
    ...b.range.mock.calls.map(([, r]) => ({ text: r.query, vars: r.vars })),
    ...b.instant.mock.calls.map(([, r]) => ({ text: r.query, vars: r.vars })),
  ];
}

function openVariablesBoard(spec: BoardSpec, extra = '') {
  const b = openBoard([], { seed: seedWith({ boards: [stubBoard('b-1', spec)] }), extra });
  const values = vi.spyOn(b.api, 'variableValues');
  values.mockImplementation((_t, req) =>
    Promise.resolve({
      planned: { label: '', match: null },
      values: req.query.includes(', job)') ? ['j1', 'j2'] : ['n1', 'n2'],
      truncated: false,
    }),
  );
  return { ...b, values };
}

describe('board variables (plan #289 §4.4)', () => {
  beforeEach(() => {
    installIntersectionObserver();
  });
  afterEach(() => {
    uninstallIntersectionObserver();
  });

  // unit:board-variables-run (acceptance, T07-013).
  it('runs every panel, sends All, and re-runs only the $node panels on a pick', async () => {
    const b = openVariablesBoard(CLICKHOUSE);
    await ready(...ALL_PANELS);
    show(...ALL_PANELS);
    await waitFor(() => {
      expect(new Set(sentVars(b).map((c) => c.text)).size).toBe(5);
    });
    const first = sentVars(b);
    const node = first.filter((c) => c.text.includes('$node'));
    expect(node).toHaveLength(3);
    for (const c of node) expect(c.vars).toEqual({ node: { all: '.+' } });
    for (const c of first.filter((x) => !x.text.includes('$node'))) expect(c.vars).toEqual({});
    await act(async () => {
      await b.router.navigate(`/t/demo/board/b-1?${ABS_Q}&var-node=n1`);
    });
    await waitFor(() => {
      expect(sentVars(b).length).toBe(first.length + 3);
    });
    await flush();
    const again = sentVars(b).slice(first.length);
    expect(again).toHaveLength(3);
    for (const c of again) {
      expect(c.text).toContain('$node');
      expect(c.vars).toEqual({ node: { values: ['n1'] } });
    }
  });

  // Review r1: a name a variable query uses and the board does not define is a legacy chip, and its
  // URL value goes into the list request.
  it('a legacy name of a variable query has a chip and its URL value', async () => {
    const node = CLICKHOUSE.variables?.[0] as BoardVariable;
    const spec: BoardSpec = {
      ...CLICKHOUSE,
      variables: [
        { ...node, query: { lang: 'promql', text: 'label_values(up{job="$job"}, instance)' } },
      ],
    };
    const b = openVariablesBoard(spec, '&var-job=api');
    await ready(...ALL_PANELS);
    expect(screen.getByRole('button', { name: 'Variable job: api' })).toBeInTheDocument();
    await waitFor(() => {
      expect(b.values).toHaveBeenCalled();
    });
    expect(b.values.mock.calls[0]?.[1].vars).toEqual({ job: 'api' });
  });

  // unit:variable-too-many (SRF-017, plan #289 §4.2 step 3).
  it('201 values block the $node panels and the dependent list; 200 run', async () => {
    const node = CLICKHOUSE.variables?.[0] as BoardVariable;
    const spec: BoardSpec = {
      ...CLICKHOUSE,
      variables: [
        node,
        {
          name: 'job',
          label: 'Job',
          kind: 'query',
          query: { lang: 'promql', text: 'label_values(up{instance=~"$node"}, job)' },
          multi: false,
          includeAll: false,
          sort: 'none',
          refresh: 'load',
        },
      ],
    };
    const many = Array.from({ length: 201 }, (_, i) => `&var-node=v${String(i)}`).join('');
    const b = openVariablesBoard(spec, many);
    await ready(...ALL_PANELS);
    show(...ALL_PANELS);
    await waitFor(() => {
      expect(new Set(sentVars(b).map((c) => c.text)).size).toBe(2);
    });
    await flush();
    for (const title of NODE_PANELS) {
      expect(panelOf(title).textContent).toContain('Too many values selected for Node');
    }
    expect(sentVars(b).filter((c) => c.text.includes('$node'))).toHaveLength(0);
    expect(screen.getByRole('button', { name: /^Variable Job: / }).textContent).toContain(
      'Waiting for Node',
    );
    expect(b.values.mock.calls.filter(([, r]) => r.query.includes(', job)'))).toHaveLength(0);

    const twoHundred = Array.from({ length: 200 }, (_, i) => `&var-node=v${String(i)}`).join('');
    await act(async () => {
      await b.router.navigate(`/t/demo/board/b-1?${ABS_Q}${twoHundred}`);
    });
    await waitFor(() => {
      expect(sentVars(b).filter((c) => c.text.includes('$node'))).toHaveLength(3);
    });
    await waitFor(() => {
      expect(b.values.mock.calls.filter(([, r]) => r.query.includes(', job)'))).toHaveLength(1);
    });
    for (const c of sentVars(b).filter((x) => x.text.includes('$node'))) {
      expect((c.vars as Record<string, { values: string[] }>)['node']?.values).toHaveLength(200);
    }
  });
});
