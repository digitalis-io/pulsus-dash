/**
 * Board bar chart panels (plan #173 Part 3b §4.3, §5): a pick's action on a board panel and at full
 * screen (inspect and toggle the filter, brush, clear, a table row), and one selection across two
 * panels holding the same key. The pick events come from the fake engine's frames.
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataPanelSpec } from '../../api/types';
import type { RangeResult } from '../../data/decode';
import { keyHash } from '../../dev/keyHash';
import type { PickEvent } from '../../engine/api';
import { resetQueryLanguages } from '../../boards/useQueryLanguage';
import { frameOf, openBoard, openMenu, ready, show, type Board } from '../../test/boardPanelKit';
import { panel, panelOf, panelState } from '../../test/boardTestKit';
import { fakeEditorSource } from '../../test/fakeEditor';
import type { FakeFrame } from '../../test/fakeEngine';
import {
  installIntersectionObserver,
  uninstallIntersectionObserver,
} from '../../test/fakeIntersectionObserver';
import { F } from '../../test/fakePromSource';
import { installResizeObserver, resizeAll } from '../../test/fakeResizeObserver';
import { BY_VERSION_Q, rangeByVersion, T0 } from '../../test/rangeFixtures';

vi.mock('../../editor/editor', () => import('../../test/fakeEditor'));

beforeEach(() => {
  installResizeObserver();
  installIntersectionObserver();
  resetQueryLanguages();
  fakeEditorSource.data = F;
  // The axis measure: 6 px per character (as `CategoryChart.test.tsx`).
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () =>
      ({
        font: '',
        measureText: (s: string) => ({ width: 6 * Array.from(s).length }),
      }) as unknown as CanvasRenderingContext2D,
  );
});

afterEach(() => {
  cleanup();
  uninstallIntersectionObserver();
  vi.restoreAllMocks();
});

const K = (version: string): string => keyHash({ version });
const bar = (id: string, title: string): DataPanelSpec =>
  panel(id, title, BY_VERSION_Q, 'barchart');

/** The board of `panels`, every range call answered by `answer`, each panel's bar chart sized. */
async function openBars(
  panels: readonly DataPanelSpec[],
  answer: () => RangeResult = () => rangeByVersion(),
  extra = '',
): Promise<Board> {
  const t = openBoard(panels, { extra });
  t.range.mockImplementation(() => Promise.resolve(answer()));
  const titles = panels.map((p) => p.title);
  await ready(...titles);
  show(...titles);
  for (const title of titles) {
    await waitFor(() => {
      expect(panelOf(title)).toHaveAttribute('data-panel-vis', 'barchart');
    });
    expect(panelState(title)).toBe('frame');
  }
  act(() => {
    resizeAll(1000, 240);
  });
  for (const title of titles) {
    await waitFor(() => {
      expect(frameOf(t, title)).toBeDefined();
    });
  }
  return t;
}

function pick(f: FakeFrame | undefined, e: PickEvent): void {
  act(() => {
    f?.emit('pick', e);
  });
}

const click = (key: string): PickEvent => ({ keys: [key], gesture: 'click', source: 'pointer' });

const search = (t: Board): URLSearchParams => new URLSearchParams(t.router.state.location.search);

/** The Inspector's heading, or null when it is closed. */
function inspectorHeading(title: string): string | null {
  const aside = screen.queryByRole('complementary', { name: title });
  return aside === null
    ? null
    : (within(aside).queryByRole('heading', { level: 2 })?.textContent ?? null);
}

const selectionKeys = (title: string): string | null | undefined =>
  panelOf(title).querySelector('[data-chart-frame]')?.getAttribute('data-selection-keys');

describe('board actions (#173 Part 3b §4.3)', () => {
  it('a click inspects and toggles the filter, with no new request', async () => {
    const t = await openBars([bar('p-1', 'Versions')]);
    const sent = t.range.mock.calls.length;
    pick(frameOf(t, 'Versions'), click(K('2.31')));
    await waitFor(() => {
      expect(inspectorHeading('Versions')).toBe('2.31');
    });
    await waitFor(() => {
      expect(search(t).getAll('f')).toEqual(['version=2.31']);
    });
    expect(selectionKeys('Versions')).toBe(K('2.31'));
    expect(t.range.mock.calls.length).toBe(sent);
    pick(frameOf(t, 'Versions'), click(K('2.31')));
    await waitFor(() => {
      expect(search(t).getAll('f')).toEqual([]);
    });
    expect(t.range.mock.calls.length).toBe(sent);
  });

  it('a brush selects without the Inspector; an empty pick clears', async () => {
    const t = await openBars([bar('p-1', 'Versions')]);
    pick(frameOf(t, 'Versions'), {
      keys: [K('2.31'), K('2.29')],
      gesture: 'brush',
      source: 'pointer',
    });
    await waitFor(() => {
      expect(selectionKeys('Versions')).toBe(`${K('2.31')},${K('2.29')}`);
    });
    expect(inspectorHeading('Versions')).toBeNull();
    expect(search(t).getAll('f')).toEqual([]);
    pick(frameOf(t, 'Versions'), { keys: [], gesture: 'click', source: 'pointer' });
    await waitFor(() => {
      expect(selectionKeys('Versions')).toBe('');
    });
  });

  it('a table row picks as a click', async () => {
    const t = await openBars([bar('p-1', 'Versions')]);
    fireEvent.keyDown(within(panelOf('Versions')).getByRole('listbox'), {
      key: 'T',
      shiftKey: true,
    });
    const grid = await within(panelOf('Versions')).findByRole('grid', { name: 'Versions' });
    await t.user.click(within(grid).getByRole('button', { name: '2.31' }));
    await waitFor(() => {
      expect(inspectorHeading('Versions')).toBe('2.31');
    });
    expect(search(t).getAll('f')).toEqual(['version=2.31']);
  });
});

describe('full screen actions (#173 Part 3b §4.3)', () => {
  it('the table and ghost carry over; a click closes the dialog, then inspects', async () => {
    const t = await openBars([bar('p-1', 'Versions')]);
    await openMenu(t, 'Versions');
    await t.user.click(await screen.findByRole('menuitem', { name: 'Show baseline ghost' }));
    await openMenu(t, 'Versions');
    await t.user.click(await screen.findByRole('menuitem', { name: 'Show as table' }));
    await within(panelOf('Versions')).findByRole('grid', { name: 'Versions' });
    await t.user.click(screen.getByRole('button', { name: 'Full screen: Versions' }));
    const dialog = await screen.findByRole('dialog', { name: 'Versions' });
    const grid = await within(dialog).findByRole('grid', { name: 'Versions' });
    // Back to the chart in the dialog: the ghost is on its spec.
    fireEvent.keyDown(grid, { key: 'T', shiftKey: true });
    act(() => {
      resizeAll(1000, 480);
    });
    const inDialog = (): FakeFrame | undefined =>
      t.engine.frames.findLast((f) => f.disposed === 0 && dialog.contains(f.canvas));
    await waitFor(() => {
      expect(inDialog()?.last('setSpec')?.[0]).toMatchObject({ kind: 'barchart', ghost: true });
    });
    pick(inDialog(), click(K('2.31')));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Versions' })).toBeNull();
    });
    await waitFor(() => {
      expect(inspectorHeading('Versions')).toBe('2.31');
    });
    expect(search(t).getAll('f')).toEqual(['version=2.31']);
  });

  it('a brush and an empty pick act in place; a table row closes and inspects', async () => {
    const t = await openBars([bar('p-1', 'Versions')]);
    await t.user.click(screen.getByRole('button', { name: 'Full screen: Versions' }));
    const dialog = await screen.findByRole('dialog', { name: 'Versions' });
    act(() => {
      resizeAll(1000, 480);
    });
    const inDialog = (): FakeFrame | undefined =>
      t.engine.frames.findLast((f) => f.disposed === 0 && dialog.contains(f.canvas));
    await waitFor(() => {
      expect(inDialog()).toBeDefined();
    });
    pick(inDialog(), { keys: [K('2.31'), K('2.29')], gesture: 'brush', source: 'pointer' });
    await waitFor(() => {
      expect(selectionKeys('Versions')).toBe(`${K('2.31')},${K('2.29')}`);
    });
    expect(screen.getByRole('dialog', { name: 'Versions' })).toBeInTheDocument();
    pick(inDialog(), { keys: [], gesture: 'click', source: 'pointer' });
    await waitFor(() => {
      expect(selectionKeys('Versions')).toBe('');
    });
    fireEvent.keyDown(within(dialog).getByRole('listbox'), { key: 'T', shiftKey: true });
    const grid = await within(dialog).findByRole('grid', { name: 'Versions' });
    await t.user.click(within(grid).getByRole('button', { name: '2.31' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Versions' })).toBeNull();
    });
    await waitFor(() => {
      expect(inspectorHeading('Versions')).toBe('2.31');
    });
    expect(search(t).getAll('f')).toEqual(['version=2.31']);
  });
});

describe('unit:category-duplicates (selection)', () => {
  it('a click on a combined bar selects its key; the other panel holding it is told', async () => {
    const KEY = K('2.31');
    const dupes = (): RangeResult => {
      const r = rangeByVersion();
      const at = Float64Array.of(T0, T0 + 5_000, T0 + 10_000);
      return {
        ...r,
        series: [
          {
            key: KEY,
            labels: { version: '2.31' },
            timestamps: at,
            values: Float64Array.of(50, 50, 50),
          },
          {
            key: KEY,
            labels: { version: '2.31' },
            timestamps: at,
            values: Float64Array.of(70, 70, 70),
          },
          {
            key: K('2.30'),
            labels: { version: '2.30' },
            timestamps: at,
            values: Float64Array.of(20, 20, 20),
          },
        ],
      };
    };
    const t = await openBars([bar('p-1', 'One'), bar('p-2', 'Two')], dupes);
    pick(frameOf(t, 'One'), click(KEY));
    await waitFor(() => {
      expect(selectionKeys('One')).toBe(KEY);
    });
    expect(selectionKeys('Two')).toBe(KEY);
    expect(frameOf(t, 'Two')?.last('setSelection')?.[0]).toMatchObject({ keys: [KEY] });
  });
});
