/**
 * Render and mount counts of the board's panels (#111; stabilised by plan #198 Part 3a §4.5). One grid serves View and Edit mode, so
 * entering Edit mode (Edit board, or Edit panel from View mode) and leaving it neither unmount,
 * mount nor render a panel; opening the editor from View mode renders no other panel.
 * In Edit mode, opening the panel editor, editing in it and closing it render only the panel being
 * edited. A panel is counted through its `PanelFullScreen`, which every `PanelFrame` render
 * renders and which mounts and unmounts with it.
 */
import type { QueryClient } from '@tanstack/react-query';
import { act, screen, waitFor, within } from '@testing-library/react';
import { useEffect } from 'react';
import type { DataRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineWrapper } from '../../test/boardTestKit';
import { installResizeObserver } from '../../test/fakeResizeObserver';
import { renderApp } from '../../test/renderApp';

const counts = vi.hoisted(() => ({
  renders: new Map<string, number>(),
  mounts: new Map<string, number>(),
  unmounts: new Map<string, number>(),
  /** The diagnostic (plan #198 Part 3a §4.5): each counted render, printed when a count fails. */
  log: [] as string[],
  /** The last props each panel's `PanelFullScreen` and `PanelFrame` rendered with. */
  last: new Map<string, object>(),
  t0: 0,
  /** When a panel last rendered (never cleared), for `settle`. */
  lastAt: 0,
  /** When each panel last rendered, and when the router last navigated (never cleared). */
  renderedAt: new Map<string, number>(),
  navAt: 0,
  /** Every navigation of the board under test, with its time (never cleared). */
  navigations: [] as string[],
}));

/** The names of the props whose values differ from the last render's (`onClose` is per render). */
function diff(key: string, props: object): string {
  const was = counts.last.get(key);
  counts.last.set(key, props);
  if (was === undefined) return '(first)';
  const before = new Map(Object.entries(was));
  const after = new Map(Object.entries(props));
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter(
    (k) => k !== 'onClose' && !Object.is(before.get(k), after.get(k)),
  );
  return changed.length === 0 ? '(none)' : changed.join(',');
}

function note(what: string, title: string, props: object): void {
  counts.lastAt = performance.now();
  const ms = (counts.lastAt - counts.t0).toFixed(1);
  counts.log.push(`${ms} ms ${what} ${title}: ${diff(`${what}:${title}`, props)}`);
}

function bump(m: Map<string, number>, k: string): void {
  m.set(k, (m.get(k) ?? 0) + 1);
}

/** Counts its instance's mount and unmount under the title it mounted with. */
function useMountSpy(title: string): void {
  useEffect(() => {
    bump(counts.mounts, title);
    return () => {
      bump(counts.unmounts, title);
    };
    // Once per instance: a later title is the same instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

vi.mock('./PanelFullScreen', async (importOriginal) => {
  const m = await importOriginal<typeof import('./PanelFullScreen')>();
  return {
    ...m,
    PanelFullScreen: function CountedFullScreen(p: Parameters<typeof m.PanelFullScreen>[0]) {
      bump(counts.renders, p.title);
      note('render', p.title, p);
      counts.renderedAt.set(p.title, performance.now());
      useMountSpy(p.title);
      return m.PanelFullScreen(p);
    },
  };
});

// The page's props reach a panel through the memoised `PanelFrame`: the wrapper below renders only
// when one of them changed, so its log line names the page prop that did (§4.5).
vi.mock('./PanelFrame', async (importOriginal) => {
  const m = await importOriginal<typeof import('./PanelFrame')>();
  const { createElement, forwardRef, memo } = await import('react');
  return {
    ...m,
    PanelFrame: memo(
      forwardRef<HTMLElement, Parameters<typeof m.PanelFrame>[0]>(function LoggedFrame(p, ref) {
        note('page-props', p.panel.title, p);
        return createElement(m.PanelFrame, { ...p, ref });
      }),
    ),
  };
});

beforeEach(() => {
  installResizeObserver();
});

/** `expect(renders of titles).toEqual(n each)`, printing the render log when it fails. */
function expectRenders(titles: readonly string[], n: number): void {
  const got = of(counts.renders, titles);
  const want = each(titles, n);
  const nav = `navigations (absolute):\n${counts.navigations.join('\n')}`;
  const log = `renders since clear (at ${counts.t0.toFixed(1)} ms):\n${counts.log.join('\n')}`;
  expect(got, `${log}\n${nav}`).toEqual(want);
}

const OTHERS = ['Error ratio', 'Errors', 'Request latency'];
const ALL = ['Request rate', ...OTHERS];

function of(m: Map<string, number>, titles: readonly string[]): Record<string, number> {
  return Object.fromEntries(titles.map((x) => [x, m.get(x) ?? 0]));
}

function each(titles: readonly string[], n: number): Record<string, number> {
  return Object.fromEntries(titles.map((x) => [x, n]));
}

function clear(): void {
  counts.renders.clear();
  counts.mounts.clear();
  counts.unmounts.clear();
  counts.log.length = 0;
  counts.t0 = performance.now();
}

/**
 * How long the setup steps (the board mounting, the Edit chrome) may take on a loaded runner, and
 * so each test: they are not what the tests measure.
 */
const SETUP_MS = 15_000;
const TEST_MS = 60_000;

/** The query client and router of the board under test, for `settle`. */
let client: QueryClient | null = null;
let router: DataRouter | null = null;

/**
 * Lets the panels' own follow-up renders (the grid's width, their data, their viewport state)
 * settle, so a busy runner does not count them (plan #198 Part 3a §4.5). The diagnostic found such
 * late renders with no page prop changed: on a loaded runner a panel rendered an earlier
 * navigation's location (React Router applies it in a transition) only after the 50 ms quiet
 * window, inside the measured step. So: until no panel has rendered for 200 ms, every panel has
 * rendered since the last navigation, the router is idle and no query is fetching; at most 5 s.
 */
async function settle(): Promise<void> {
  const start = performance.now();
  while (performance.now() - start < 5_000) {
    await act(async () => {
      await new Promise((res) => setTimeout(res, 25));
    });
    const quiet = performance.now() - counts.lastAt >= 200;
    // A navigation reaches the panels in a transition: each must have rendered it.
    const caughtUp = [...counts.renderedAt.values()].every((t) => t > counts.navAt);
    const idle = router?.state.navigation.state === 'idle';
    if (quiet && caughtUp && idle && (client?.isFetching() ?? 0) === 0) return;
  }
}

/** The board in View mode, its four panels mounted. */
async function viewBoard() {
  clear();
  const r = renderApp('/t/demo/board/b-1', { wrapper: EngineWrapper });
  client = r.queryClient;
  router = r.router;
  counts.renderedAt.clear();
  counts.navAt = 0;
  counts.navigations.length = 0;
  // The diagnostic's sources: each navigation, clock tick and query change, with its time.
  const at = (what: string): void => {
    counts.log.push(`${(performance.now() - counts.t0).toFixed(1)} ms ${what}`);
  };
  r.router.subscribe((st) => {
    counts.navAt = performance.now();
    const what = `navigation ${st.location.pathname}${st.location.search} (${st.navigation.state})`;
    counts.navigations.push(`${counts.navAt.toFixed(1)} ms ${what}`);
    at(what);
  });
  r.clock.subscribe(() => {
    at('clock');
  });
  r.queryClient.getQueryCache().subscribe((e) => {
    if (e.type === 'updated') at(`query ${JSON.stringify(e.query.queryKey)} ${e.action.type}`);
  });
  await waitFor(
    () => {
      expect(of(counts.mounts, ALL)).toEqual(each(ALL, 1));
    },
    { timeout: SETUP_MS },
  );
  await settle();
  return r;
}

/** The four panels show their Edit-mode chrome (a modal editor hides it from the a11y tree). */
async function editChrome(): Promise<void> {
  await waitFor(
    () => {
      expect(document.querySelectorAll('[data-drag-handle]')).toHaveLength(4);
    },
    { timeout: SETUP_MS },
  );
}

async function editGrid() {
  const r = await viewBoard();
  await r.user.click(await screen.findByRole('button', { name: 'Edit board' }));
  await editChrome();
  await settle();
  return r;
}

describe('board render counts (#111)', { timeout: TEST_MS }, () => {
  it('opening the editor does not re-render the other panels', async () => {
    const { user } = await editGrid();
    await user.click(await screen.findByRole('button', { name: 'Panel menu: Request rate' }));
    await settle();
    clear();
    await user.click(await screen.findByRole('menuitem', { name: 'Edit panel' }));
    await screen.findByRole('dialog', { name: 'Edit panel' });
    expectRenders(OTHERS, 0);
  });

  it('editing in the editor does not re-render the other panels', async () => {
    const { user } = await editGrid();
    await user.click(await screen.findByRole('button', { name: 'Panel menu: Request rate' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit panel' }));
    const d = await screen.findByRole('dialog', { name: 'Edit panel' });
    await settle();
    clear();
    await user.type(within(d).getByRole('textbox', { name: 'Title' }), 'X');
    // The edited panel shows the new title at once.
    expect(counts.renders.get('Request rateX')).toBeGreaterThan(0);
    expectRenders(OTHERS, 0);
  });

  it('closing the editor does not re-render the other panels', async () => {
    const { user } = await editGrid();
    await user.click(await screen.findByRole('button', { name: 'Panel menu: Request rate' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit panel' }));
    const d = await screen.findByRole('dialog', { name: 'Edit panel' });
    await settle();
    clear();
    await user.click(within(d).getByRole('button', { name: 'Done' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Edit panel' })).toBeNull();
    });
    expectRenders(OTHERS, 0);
  });

  it('entering Edit mode keeps every panel mounted and renders none', async () => {
    const { user } = await viewBoard();
    const edit = await screen.findByRole('button', { name: 'Edit board' });
    await settle();
    clear();
    await user.click(edit);
    await editChrome();
    await settle();
    expect(of(counts.unmounts, ALL)).toEqual(each(ALL, 0));
    expect(of(counts.mounts, ALL)).toEqual(each(ALL, 0));
    expectRenders(ALL, 0);
  });

  it('Edit panel from View mode keeps the panels mounted and renders no other panel', async () => {
    const { user } = await viewBoard();
    await user.click(await screen.findByRole('button', { name: 'Panel menu: Request rate' }));
    await settle();
    clear();
    await user.click(await screen.findByRole('menuitem', { name: 'Edit panel' }));
    await screen.findByRole('dialog', { name: 'Edit panel' });
    await editChrome();
    await settle();
    expect(of(counts.unmounts, ALL)).toEqual(each(ALL, 0));
    expect(of(counts.mounts, ALL)).toEqual(each(ALL, 0));
    expectRenders(OTHERS, 0);
  });

  it('leaving Edit mode keeps every panel mounted and renders none', async () => {
    const { user } = await editGrid();
    await settle();
    clear();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await screen.findByRole('button', { name: 'Edit board' });
    await settle();
    expect(of(counts.unmounts, ALL)).toEqual(each(ALL, 0));
    expect(of(counts.mounts, ALL)).toEqual(each(ALL, 0));
    expectRenders(ALL, 0);
  });
});
