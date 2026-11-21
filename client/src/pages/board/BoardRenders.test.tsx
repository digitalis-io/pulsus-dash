/**
 * Render counts of the board's panels (#111). In Edit mode, opening the panel editor, editing in
 * it and closing it render only the panel being edited; the rest of the grid is left alone. Entering
 * Edit mode (Edit board, or Edit panel from View mode) swaps the View grid for the lazy Edit grid
 * (`react-grid-layout`), so every panel mounts again: the last two tests record that. A panel's
 * renders are counted through its `PanelFullScreen`, which every `PanelFrame` render renders.
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineWrapper } from '../../test/boardTestKit';
import { installResizeObserver } from '../../test/fakeResizeObserver';
import { renderApp } from '../../test/renderApp';

const counts = vi.hoisted(() => new Map<string, number>());
vi.mock('./PanelFullScreen', async (importOriginal) => {
  const m = await importOriginal<typeof import('./PanelFullScreen')>();
  return {
    ...m,
    PanelFullScreen: (p: Parameters<typeof m.PanelFullScreen>[0]) => {
      counts.set(p.title, (counts.get(p.title) ?? 0) + 1);
      return m.PanelFullScreen(p);
    },
  };
});

beforeEach(() => {
  installResizeObserver();
});

const OTHERS = ['Error ratio', 'Errors', 'Request latency'];
const ALL = ['Request rate', ...OTHERS];

function rendersOf(titles: readonly string[]): Record<string, number> {
  return Object.fromEntries(titles.map((x) => [x, counts.get(x) ?? 0]));
}

const none = Object.fromEntries(OTHERS.map((x) => [x, 0]));

async function editGrid() {
  const r = renderApp('/t/demo/board/b-1', { wrapper: EngineWrapper });
  await r.user.click(await screen.findByRole('button', { name: 'Edit board' }));
  await waitFor(() => {
    expect(document.querySelectorAll('.react-grid-item')).toHaveLength(4);
  });
  // Let the grid's own follow-up renders (its width, the panels' data) settle.
  await act(async () => {
    await new Promise((res) => setTimeout(res, 50));
  });
  return r;
}

describe('board render counts (#111)', () => {
  it('opening the editor does not re-render the other panels', async () => {
    const { user } = await editGrid();
    await user.click(await screen.findByRole('button', { name: 'Panel menu: Request rate' }));
    counts.clear();
    await user.click(await screen.findByRole('menuitem', { name: 'Edit panel' }));
    await screen.findByRole('dialog', { name: 'Edit panel' });
    expect(rendersOf(OTHERS)).toEqual(none);
  });

  it('editing in the editor does not re-render the other panels', async () => {
    const { user } = await editGrid();
    await user.click(await screen.findByRole('button', { name: 'Panel menu: Request rate' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit panel' }));
    const d = await screen.findByRole('dialog', { name: 'Edit panel' });
    counts.clear();
    await user.type(within(d).getByRole('textbox', { name: 'Title' }), 'X');
    // The edited panel shows the new title at once.
    expect(counts.get('Request rateX')).toBeGreaterThan(0);
    expect(rendersOf(OTHERS)).toEqual(none);
  });

  it('closing the editor does not re-render the other panels', async () => {
    const { user } = await editGrid();
    await user.click(await screen.findByRole('button', { name: 'Panel menu: Request rate' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit panel' }));
    const d = await screen.findByRole('dialog', { name: 'Edit panel' });
    counts.clear();
    await user.click(within(d).getByRole('button', { name: 'Done' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Edit panel' })).toBeNull();
    });
    expect(rendersOf(OTHERS)).toEqual(none);
  });

  it('entering Edit mode mounts every panel again in the Edit grid', async () => {
    const { user } = renderApp('/t/demo/board/b-1', { wrapper: EngineWrapper });
    const edit = await screen.findByRole('button', { name: 'Edit board' });
    counts.clear();
    await user.click(edit);
    await waitFor(() => {
      expect(document.querySelectorAll('.react-grid-item')).toHaveLength(4);
    });
    for (const n of Object.values(rendersOf(ALL))) expect(n).toBeGreaterThan(0);
  });

  it('Edit panel from View mode enters Edit mode: every panel mounts again', async () => {
    const { user } = renderApp('/t/demo/board/b-1', { wrapper: EngineWrapper });
    await user.click(await screen.findByRole('button', { name: 'Panel menu: Request rate' }));
    counts.clear();
    await user.click(await screen.findByRole('menuitem', { name: 'Edit panel' }));
    await screen.findByRole('dialog', { name: 'Edit panel' });
    await waitFor(() => {
      expect(document.querySelectorAll('.react-grid-item')).toHaveLength(4);
    });
    for (const n of Object.values(rendersOf(ALL))) expect(n).toBeGreaterThan(0);
  });
});
