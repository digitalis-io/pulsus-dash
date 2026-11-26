/**
 * Render and mount counts of the board's panels (#111). One grid serves View and Edit mode, so
 * entering Edit mode (Edit board, or Edit panel from View mode) and leaving it neither unmount,
 * mount nor render a panel; opening the editor from View mode renders no other panel.
 * In Edit mode, opening the panel editor, editing in it and closing it render only the panel being
 * edited. A panel is counted through its `PanelFullScreen`, which every `PanelFrame` render
 * renders and which mounts and unmounts with it.
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import { useEffect } from 'react';
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
  last: new Map<string, Record<string, unknown>>(),
  t0: 0,
}));

/** The names of the props whose values differ from the last render's (`onClose` is per render). */
function diff(key: string, props: Record<string, unknown>): string {
  const before = counts.last.get(key);
  counts.last.set(key, props);
  if (before === undefined) return '(first)';
  const changed = Object.keys({ ...before, ...props }).filter(
    (k) => k !== 'onClose' && !Object.is(before[k], props[k]),
  );
  return changed.length === 0 ? '(none)' : changed.join(',');
}

function note(what: string, title: string, props: Record<string, unknown>): void {
  const ms = (performance.now() - counts.t0).toFixed(1);
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
        note('page-props', p.panel.title, p as unknown as Record<string, unknown>);
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
  expect(got, `renders since clear:\n${counts.log.join('\n')}`).toEqual(want);
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

function total(): number {
  let n = 0;
  for (const v of counts.renders.values()) n += v;
  return n;
}

/**
 * Lets the panels' own follow-up renders (the grid's width, their data, their viewport state)
 * settle: until no panel renders for 50 ms (at most 2 s), so a busy runner does not count them.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const before = total();
    await act(async () => {
      await new Promise((res) => setTimeout(res, 50));
    });
    if (total() === before) return;
  }
}

/** The board in View mode, its four panels mounted. */
async function viewBoard() {
  clear();
  const r = renderApp('/t/demo/board/b-1', { wrapper: EngineWrapper });
  await waitFor(() => {
    expect(of(counts.mounts, ALL)).toEqual(each(ALL, 1));
  });
  await settle();
  return r;
}

/** The four panels show their Edit-mode chrome (a modal editor hides it from the a11y tree). */
async function editChrome(): Promise<void> {
  await waitFor(() => {
    expect(document.querySelectorAll('[data-drag-handle]')).toHaveLength(4);
  });
}

async function editGrid() {
  const r = await viewBoard();
  await r.user.click(await screen.findByRole('button', { name: 'Edit board' }));
  await editChrome();
  await settle();
  return r;
}

describe('board render counts (#111)', () => {
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
