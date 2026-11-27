/**
 * `unit:board-health` (#282 Part 2a §4.3, §4.9): a failing stat panel takes the failing state
 * class and `data-stat-state`, and the board's status line counts the mounted board panels that
 * are failing. Collapsed sections (unmounted), full screen and the editor preview do not report;
 * a remount reports once; a panel outside a board renders without a provider.
 */
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataPanelSpec, RangeRequest } from '../../api/types';
import { useReportHealth } from '../../boards/boardHealth';
import { resetQueryLanguages } from '../../boards/useQueryLanguage';
import { openBoard, ready, show, type Board } from '../../test/boardPanelKit';
import { boardWith, panel, panelOf } from '../../test/boardTestKit';
import { range, ser } from '../../test/exploreTestKit';
import { fakeEditorSource } from '../../test/fakeEditor';
import {
  installIntersectionObserver,
  uninstallIntersectionObserver,
} from '../../test/fakeIntersectionObserver';
import { F } from '../../test/fakePromSource';
import { installResizeObserver, resizeAll } from '../../test/fakeResizeObserver';
import { StateEncoding } from '../../theme/stateEncoding';

vi.mock('../../editor/editor', () => import('../../test/fakeEditor'));

beforeEach(() => {
  installResizeObserver();
  installIntersectionObserver();
  resetQueryLanguages();
  fakeEditorSource.data = F;
});

afterEach(() => {
  cleanup();
  uninstallIntersectionObserver();
});

/** Failing at 4 and above. */
function stat(id: string, title: string, text: string): DataPanelSpec {
  return {
    ...panel(id, title, text, 'stat'),
    vis: {
      kind: 'stat',
      thresholds: { direction: 'above', steps: [{ value: 4, state: 'failing', label: '' }] },
    },
  };
}

const A = stat('p-1', 'A stat', 'a_ratio');
const B = stat('p-2', 'B stat', 'b_ratio');
const C = stat('p-3', 'C stat', 'c_ratio');

/** Each query's last value; ≥ 4 is failing. */
const last: Record<string, number> = {};

function openHealthBoard(): Board {
  const t = openBoard([A, B], {
    seed: boardWith([A, B], {
      sections: [{ id: 's-1', title: 'More', collapsed: true, panels: [C] }],
    }),
  });
  t.range.mockImplementation((_tenant: string, req: RangeRequest) =>
    Promise.resolve(range([ser(1, { instance: 'x' }, [1, 2, last[req.query] ?? 0])])),
  );
  return t;
}

const health = (): HTMLElement | null => document.querySelector('[data-board-health]');

async function expectHealth(text: string | null): Promise<void> {
  await waitFor(() => {
    if (text === null) expect(health()).toBeNull();
    else expect(health()).toHaveTextContent(text);
  });
}

async function refresh(t: Board): Promise<void> {
  await t.user.click(screen.getByRole('button', { name: 'Refresh now' }));
}

function sizeAll(): void {
  act(() => {
    resizeAll(1000, 240);
  });
}

async function toggleSection(t: Board): Promise<void> {
  await t.user.click(screen.getByRole('button', { name: 'More' }));
}

describe('unit:board-health', () => {
  it('counts the failing board panels in view', async () => {
    Object.assign(last, { a_ratio: 5, b_ratio: 1, c_ratio: 5 });
    const t = openHealthBoard();
    await ready('A stat', 'B stat');
    show('A stat', 'B stat');
    await waitFor(() => {
      expect(panelOf('A stat')).toHaveAttribute('data-stat-state', 'failing');
    });
    expect(panelOf('A stat').classList.contains(StateEncoding.failing.className)).toBe(true);
    expect(panelOf('B stat').classList.contains(StateEncoding.failing.className)).toBe(false);
    await expectHealth('1 panel failing');

    last['b_ratio'] = 5;
    await refresh(t);
    await expectHealth('2 panels failing');

    Object.assign(last, { a_ratio: 1, b_ratio: 1 });
    await refresh(t);
    await expectHealth(null);

    // The collapsed section's failing C counts only while it is expanded (mounted), once each time.
    await toggleSection(t);
    await screen.findByRole('heading', { level: 3, name: 'C stat' });
    sizeAll();
    show('C stat');
    await expectHealth('1 panel failing');
    await toggleSection(t);
    await expectHealth(null);
    await toggleSection(t);
    await screen.findByRole('heading', { level: 3, name: 'C stat' });
    sizeAll();
    show('C stat');
    await expectHealth('1 panel failing');
    expect(health()).not.toHaveTextContent('2 panels failing');
    await toggleSection(t);
    await expectHealth(null);

    last['a_ratio'] = 5;
    await refresh(t);
    await expectHealth('1 panel failing');

    // Full screen draws A again but does not report it a second time.
    await t.user.click(screen.getByRole('button', { name: 'Full screen: A stat' }));
    const full = await screen.findByRole('dialog', { name: 'A stat' });
    expect(full).toBeInTheDocument();
    await expectHealth('1 panel failing');
    await t.user.click(within(full).getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'A stat' })).toBeNull();
    });

    // Nor does the editor's preview.
    await t.user.click(screen.getByRole('button', { name: 'Edit board' }));
    await t.user.click(await screen.findByRole('button', { name: 'Panel menu: A stat' }));
    await t.user.click(await screen.findByRole('menuitem', { name: 'Edit panel' }));
    const editor = await screen.findByRole('dialog', { name: 'Edit panel' });
    await within(editor).findByRole('region', { name: 'Preview' });
    await expectHealth('1 panel failing');
    await t.user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Edit panel' })).toBeNull();
    });

    // Removing A forgets it.
    await t.user.click(screen.getByRole('button', { name: 'Panel menu: A stat' }));
    await t.user.click(await screen.findByRole('menuitem', { name: 'Remove' }));
    await waitFor(() => {
      expect(screen.queryByRole('heading', { level: 3, name: 'A stat' })).toBeNull();
    });
    await expectHealth(null);
  });

  it('reports nothing and does not throw without a provider', () => {
    function Probe() {
      useReportHealth('p-x', true);
      return <p>probe</p>;
    }
    render(<Probe />);
    expect(screen.getByText('probe')).toBeInTheDocument();
  });
});
