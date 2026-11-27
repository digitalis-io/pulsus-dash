/**
 * Board PromQL panels, continued (plan #64 §5.1): variables and macros, errors and notices, the
 * panel menu and Open in Explore, the panel editor's query field, and the board's time on open.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StubApi, type StubSeed } from '../../api/StubApi';
import { ApiError, type PlannedQuery } from '../../api/types';
import type { RangeResult } from '../../data/decode';
import { refusalText } from '../../explore/statusText';
import { resetQueryLanguages } from '../../boards/useQueryLanguage';
import {
  ABS,
  ABS24,
  ABS_SEARCH,
  calls,
  editorOn,
  exploreItem,
  exploreState,
  flush,
  holdRange,
  HOUR,
  MIX,
  openBoard,
  openMenu,
  preview,
  qOf,
  ready,
  REL,
  reqs,
  runKeys,
  settled,
  settledLanguage,
  show,
  T13,
  typeQuery,
  type Board,
} from '../../test/boardPanelKit';
import { deferred, panel, panelOf, panelState, stubBoard } from '../../test/boardTestKit';
import { fakeEditorSource } from '../../test/fakeEditor';
import {
  installIntersectionObserver,
  uninstallIntersectionObserver,
} from '../../test/fakeIntersectionObserver';
import { F } from '../../test/fakePromSource';
import { installResizeObserver, resizeAll } from '../../test/fakeResizeObserver';
import { BY_VERSION_Q, C0, R_A, rangeByVersion } from '../../test/rangeFixtures';
import { logPanel, metric, openLogBoard, type LogBoard } from '../../test/boardLogKit';
import { seedWith } from '../../test/seeds';

vi.mock('../../editor/editor', () => import('../../test/fakeEditor'));

beforeEach(() => {
  installResizeObserver();
  installIntersectionObserver();
  resetQueryLanguages();
  fakeEditorSource.data = F;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
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
      // The chart stays (its own cover shows until it has drawn at the new size, #90).
      expect(panelState('Mix')).toBe('frame');
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
    expect(save.mock.calls[0]?.[3].panels[0]?.query?.text).toBe('up');
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
      await t.queryClient.query({
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

describe('query field while the board is busy (review r1 #2)', () => {
  /** b-1's Requests in the dialog with an unrun draft `up`. */
  async function dialogWithDraft() {
    const t = openBoard([panel('p-1', 'Requests', 'http_requests_total')]);
    await ready('Requests');
    show('Requests');
    await settled(t, 'Requests');
    const d = await editorOn(t, 'Requests');
    typeQuery(d, 'up');
    await flush();
    return { t, d };
  }

  /** Typing, the picker, the Run keys and button, and leaving the field change and run nothing. */
  async function nothingRuns(t: Board, d: HTMLElement): Promise<void> {
    const box = within(d).getByRole<HTMLTextAreaElement>('textbox', { name: 'Query' });
    const n = t.range.mock.calls.length;
    await t.user.type(box, 'zz');
    expect(box).toHaveValue('up');
    expect(within(d).getByRole('combobox', { name: 'Metric' })).toBeDisabled();
    runKeys(d);
    const run = within(d).getByRole('button', { name: 'Run query' });
    expect(run).toBeDisabled();
    fireEvent.click(run);
    act(() => {
      box.focus();
    });
    await t.user.tab();
    await flush();
    expect(t.range).toHaveBeenCalledTimes(n);
    expect(box).toHaveValue('up');
  }

  it('with a save held', async () => {
    const { t, d } = await dialogWithDraft();
    const gate = deferred<undefined>();
    const save = vi
      .spyOn(t.api, 'saveBoard')
      .mockImplementationOnce(() =>
        gate.promise.then(() => Promise.reject(new ApiError('network', 'held'))),
      );
    await t.user.keyboard('{Control>}s{/Control}');
    await waitFor(() => {
      expect(within(d).getByRole('status', { name: 'Save status' })).toHaveTextContent('Saving');
    });
    await nothingRuns(t, d);
    await act(async () => {
      gate.resolve(undefined);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(within(d).getByRole('status', { name: 'Save status' })).not.toHaveTextContent(
        'Saving',
      );
    });
    // The draft is the text before the save, unchanged by anything tried while it was held.
    await t.user.keyboard('{Control>}s{/Control}');
    await waitFor(() => {
      expect(save).toHaveBeenCalledTimes(2);
    });
    expect(save.mock.calls[0]?.[3].panels[0]?.query?.text).toBe('up');
    expect(save.mock.calls[1]?.[3].panels[0]?.query?.text).toBe('up');
  });

  it('with a discard held', async () => {
    const { t, d } = await dialogWithDraft();
    await t.user.click(within(d).getByRole('button', { name: 'Done' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Edit panel' })).toBeNull();
    });
    vi.spyOn(t.api, 'getBoard').mockImplementation(() => new Promise(() => undefined));
    await t.user.click(screen.getByRole('button', { name: 'Discard' }));
    const again = await editorOn(t, 'Requests');
    await nothingRuns(t, again);
  });
});

describe('panel menu: bar chart toggles (#173 Part 3b §4.3)', () => {
  const menuNames = async (t: Board | LogBoard, title: string): Promise<string[]> => {
    await openMenu(t, title);
    const menu = await screen.findByRole('menu', { name: `Panel menu: ${title}` });
    const names = within(menu)
      .getAllByRole('menuitem')
      .map((m) => m.textContent);
    await t.user.keyboard('{Escape}');
    return names;
  };
  const TOGGLES = ['Show as table', 'Show baseline ghost', 'Show anomalies'];

  it('a bar chart panel has the table, ghost and anomaly toggles; a line panel has none', async () => {
    const t = openBoard([
      panel('p-1', 'Versions', BY_VERSION_Q, 'barchart'),
      panel('p-2', 'Lines', BY_VERSION_Q, 'line'),
    ]);
    t.range.mockImplementation(() => Promise.resolve(rangeByVersion()));
    await ready('Versions', 'Lines');
    show('Versions', 'Lines');
    await waitFor(() => {
      expect(panelOf('Versions')).toHaveAttribute('data-panel-vis', 'barchart');
    });
    const bars = await menuNames(t, 'Versions');
    expect(bars.slice(-3)).toEqual(TOGGLES);
    const lines = await menuNames(t, 'Lines');
    for (const n of TOGGLES) expect(lines).not.toContain(n);

    const before = t.range.mock.calls.length;
    await openMenu(t, 'Versions');
    await t.user.click(await screen.findByRole('menuitem', { name: 'Show baseline ghost' }));
    await waitFor(() => {
      expect(t.range.mock.calls.length).toBe(before + 2);
    });
    expect(await menuNames(t, 'Versions')).toContain('Hide baseline ghost');
  });

  it('a bar chart has the header badge: Partial data when truncated, Warnings when warned (PRF-031)', async () => {
    const t = openBoard([
      panel('p-1', 'Truncated', 'bars_a', 'barchart'),
      panel('p-2', 'Warned', 'bars_b', 'barchart'),
    ]);
    t.range.mockImplementation((_tenant, req) =>
      Promise.resolve({
        ...rangeByVersion(1, req.query),
        completeness:
          req.query === 'bars_a'
            ? { ...C0, truncated: true, warnings: ['w1'] }
            : { ...C0, warnings: ['w2'] },
      }),
    );
    await ready('Truncated', 'Warned');
    show('Truncated', 'Warned');
    await waitFor(() => {
      expect(panelOf('Truncated')).toHaveAttribute('data-panel-vis', 'barchart');
    });
    await t.user.click(await screen.findByRole('button', { name: 'Partial data: Truncated' }));
    const notices = await screen.findByRole('status', { name: 'Query notices' });
    expect(notices).toHaveTextContent('w1');
    expect(within(notices).getByRole('button', { name: 'Narrow the time range' })).toBeVisible();
    await t.user.keyboard('{Escape}');
    await t.user.click(await screen.findByRole('button', { name: 'Warnings: Warned' }));
    expect(await screen.findByRole('status', { name: 'Query notices' })).toHaveTextContent('w2');
  });

  it('a LogQL bar chart has no ghost item', async () => {
    const t = openLogBoard([logPanel('p-1', 'Rates', 'rate({app="a"}[1m])', 'barchart')]);
    await ready('Rates');
    show('Rates');
    await waitFor(() => {
      expect(t.logs).toHaveLength(1);
    });
    await t.logs[0]?.resolve(metric(['a', 'b']));
    await waitFor(() => {
      expect(panelOf('Rates')).toHaveAttribute('data-panel-vis', 'barchart');
    });
    const names = await menuNames(t, 'Rates');
    expect(names).toContain('Show as table');
    expect(names).toContain('Show anomalies');
    expect(names).not.toContain('Show baseline ghost');
  });
});
