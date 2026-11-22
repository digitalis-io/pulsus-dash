/**
 * Render and mount counts of the board's panels (#111). One grid serves View and Edit mode, so
 * entering Edit mode (Edit board, or Edit panel from View mode) neither unmounts nor mounts a panel,
 * and renders each panel at most once; opening the editor from View mode renders no other panel.
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
}));

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
      useMountSpy(p.title);
      return m.PanelFullScreen(p);
    },
  };
});

beforeEach(() => {
  installResizeObserver();
});

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
}

/** Lets the grid's own follow-up renders (its width, the panels' data) settle. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((res) => setTimeout(res, 50));
  });
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
    clear();
    await user.click(await screen.findByRole('menuitem', { name: 'Edit panel' }));
    await screen.findByRole('dialog', { name: 'Edit panel' });
    expect(of(counts.renders, OTHERS)).toEqual(each(OTHERS, 0));
  });

  it('editing in the editor does not re-render the other panels', async () => {
    const { user } = await editGrid();
    await user.click(await screen.findByRole('button', { name: 'Panel menu: Request rate' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit panel' }));
    const d = await screen.findByRole('dialog', { name: 'Edit panel' });
    clear();
    await user.type(within(d).getByRole('textbox', { name: 'Title' }), 'X');
    // The edited panel shows the new title at once.
    expect(counts.renders.get('Request rateX')).toBeGreaterThan(0);
    expect(of(counts.renders, OTHERS)).toEqual(each(OTHERS, 0));
  });

  it('closing the editor does not re-render the other panels', async () => {
    const { user } = await editGrid();
    await user.click(await screen.findByRole('button', { name: 'Panel menu: Request rate' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit panel' }));
    const d = await screen.findByRole('dialog', { name: 'Edit panel' });
    clear();
    await user.click(within(d).getByRole('button', { name: 'Done' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Edit panel' })).toBeNull();
    });
    expect(of(counts.renders, OTHERS)).toEqual(each(OTHERS, 0));
  });

  it('entering Edit mode keeps every panel mounted and renders each at most once', async () => {
    const { user } = await viewBoard();
    const edit = await screen.findByRole('button', { name: 'Edit board' });
    clear();
    await user.click(edit);
    await editChrome();
    await settle();
    expect(of(counts.unmounts, ALL)).toEqual(each(ALL, 0));
    expect(of(counts.mounts, ALL)).toEqual(each(ALL, 0));
    for (const n of Object.values(of(counts.renders, ALL))) expect(n).toBeLessThanOrEqual(1);
  });

  it('Edit panel from View mode keeps the panels mounted and renders no other panel', async () => {
    const { user } = await viewBoard();
    await user.click(await screen.findByRole('button', { name: 'Panel menu: Request rate' }));
    clear();
    await user.click(await screen.findByRole('menuitem', { name: 'Edit panel' }));
    await screen.findByRole('dialog', { name: 'Edit panel' });
    await editChrome();
    await settle();
    expect(of(counts.unmounts, ALL)).toEqual(each(ALL, 0));
    expect(of(counts.mounts, ALL)).toEqual(each(ALL, 0));
    expect(of(counts.renders, OTHERS)).toEqual(each(OTHERS, 0));
  });

  it('leaving Edit mode keeps every panel mounted', async () => {
    const { user } = await editGrid();
    clear();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await screen.findByRole('button', { name: 'Edit board' });
    await settle();
    expect(of(counts.unmounts, ALL)).toEqual(each(ALL, 0));
    expect(of(counts.mounts, ALL)).toEqual(each(ALL, 0));
  });
});
