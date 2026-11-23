/**
 * Board panel legends and stat tiles (plan #64 Part B §4.4, §4.5, Appendix B.4): the legend table
 * with mean, max and last and their threshold states, the compact legend of short panels, local
 * isolation, and the stat tile's state chip and threshold text.
 */
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PanelSpec } from '../../api/types';
import type { RangeResult } from '../../data/decode';
import { resetQueryLanguages } from '../../boards/useQueryLanguage';
import { formatValue } from '../../i18n/format';
import {
  frameOf,
  lastData,
  openBoard,
  ready,
  settled,
  show,
  type Board,
} from '../../test/boardPanelKit';
import { panel, panelOf } from '../../test/boardTestKit';
import { range, ser } from '../../test/exploreTestKit';
import { fakeEditorSource } from '../../test/fakeEditor';
import {
  installIntersectionObserver,
  uninstallIntersectionObserver,
} from '../../test/fakeIntersectionObserver';
import { F } from '../../test/fakePromSource';
import { installResizeObserver, resizeOf } from '../../test/fakeResizeObserver';

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

type Vis = PanelSpec['vis'];
type Steps = NonNullable<Vis['thresholds']>['steps'];

/** B.4 legend matrix L: three series and thresholds above watch 1.5 / degraded 2.5. */
const L: RangeResult = range([
  ser(1, { instance: 'a' }, [1, 3, 1]),
  ser(2, { instance: 'b' }, [2, 2, 2]),
  ser(3, { instance: 'c' }, [1, 1, 0.5]),
]);
const ABOVE: Vis['thresholds'] = {
  direction: 'above',
  steps: [
    { value: 1.5, state: 'watch', label: '' },
    { value: 2.5, state: 'degraded', label: '' },
  ],
};
/** Per row a, b, c: the `data-state` of Mean, Max, Last ('' = none). */
const MATRIX = [
  ['watch', 'degraded', ''],
  ['watch', 'watch', 'watch'],
  ['', '', ''],
];

function withVis(vis: Vis, g?: readonly [number, number, number, number]): PanelSpec {
  return { ...panel('p-1', 'Memory', 'node_memory_free_bytes', 'line', g), vis };
}

async function openWith(p: PanelSpec, result: RangeResult = L): Promise<Board> {
  const t = openBoard([p]);
  t.range.mockResolvedValue(result);
  await ready(p.title);
  show(p.title);
  await settled(t, p.title);
  return t;
}

function stackOf(title: string): HTMLElement {
  const s = panelOf(title).querySelector<HTMLElement>('[data-legend]');
  expect(s, `no frame stack in ${title}`).not.toBeNull();
  if (s === null) throw new Error(`no frame stack in ${title}`);
  return s;
}

/** The `data-state` of every numeric cell, by body row. */
function states(table: HTMLElement): string[][] {
  return within(table)
    .getAllByRole('row')
    .slice(1)
    .map((r) =>
      within(r)
        .getAllByRole('cell')
        .slice(1)
        .map((c) => c.getAttribute('data-state') ?? ''),
    );
}

const headers = (table: HTMLElement): string[] =>
  within(table)
    .getAllByRole('columnheader')
    .map((h) => h.textContent);

const seriesCount = (t: Board, title: string): number | null => {
  const d = lastData(t, title);
  return d?.kind === 'series' ? d.series.length : null;
};

describe('board legend (#64 Part B §4.5)', () => {
  it('legend: mean, max, last with states', async () => {
    await openWith(withVis({ kind: 'line', thresholds: ABOVE }));
    const legend = await waitFor(() => {
      const el = panelOf('Memory').querySelector<HTMLElement>('[data-panel-legend="table"]');
      expect(el, 'no legend').not.toBeNull();
      if (el === null) throw new Error('no legend');
      return el;
    });
    const table = within(legend).getByRole('table');
    expect(headers(table)).toEqual(['Series', 'Mean', 'Max', 'Last']);
    expect(states(table)).toEqual(MATRIX);
    const degraded = table.querySelector<HTMLElement>('td[data-state="degraded"]');
    expect(degraded?.textContent.startsWith('◉')).toBe(true);
  });

  it('legend hidden', async () => {
    await openWith(withVis({ kind: 'line', thresholds: ABOVE, legend: { mode: 'hidden' } }));
    expect(panelOf('Memory').querySelector('[data-panel-legend]')).toBeNull();
    expect(stackOf('Memory')).toHaveAttribute('data-legend', 'hidden');
  });

  it('four-row panel: compact legend, reachable by keyboard', async () => {
    const t = await openWith(withVis({ kind: 'line', thresholds: ABOVE }, [0, 0, 6, 4]));
    act(() => {
      resizeOf(stackOf('Memory'), 1000, 156);
    });
    const compact = await waitFor(() => {
      const el = panelOf('Memory').querySelector<HTMLElement>('[data-panel-legend="compact"]');
      expect(el, 'no compact legend').not.toBeNull();
      if (el === null) throw new Error('no compact legend');
      return el;
    });
    const items = compact.querySelectorAll<HTMLElement>('[data-legend-item]');
    expect(items).toHaveLength(3);
    const user = userEvent.setup();
    screen.getByRole('button', { name: 'Panel menu: Memory' }).focus();
    for (let i = 0; i < 5 && document.activeElement !== items[0]; i++) await user.tab();
    expect(items[0]).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(items[0]).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => {
      expect(seriesCount(t, 'Memory')).toBe(1);
    });
    const button = within(compact).getByRole('button', { name: 'Legend table' });
    for (let i = 0; i < 5 && document.activeElement !== button; i++) await user.tab();
    expect(button).toHaveFocus();
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog', {
      name: 'Legend. Choose a series to show it alone; choose it again to show all.',
    });
    const table = within(dialog).getByRole('table');
    expect(headers(table)).toEqual(['Series', 'Mean', 'Max', 'Last']);
    expect(states(table)).toEqual(MATRIX);
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    // React Aria returns focus to the trigger in the next animation frame.
    await waitFor(() => {
      expect(button).toHaveFocus();
    });
  });

  it('table layout from 240 px', async () => {
    await openWith(withVis({ kind: 'line', thresholds: ABOVE }));
    const legend = (): string | null =>
      panelOf('Memory').querySelector('[data-panel-legend]')?.getAttribute('data-panel-legend') ??
      null;
    act(() => {
      resizeOf(stackOf('Memory'), 1000, 240);
    });
    await waitFor(() => {
      expect(legend()).toBe('table');
    });
    act(() => {
      resizeOf(stackOf('Memory'), 1000, 239);
    });
    await waitFor(() => {
      expect(legend()).toBe('compact');
    });
  });

  it('legend row isolates locally', async () => {
    const t = await openWith(withVis({ kind: 'line', thresholds: ABOVE }));
    const calls = t.range.mock.calls.length;
    const legend = await waitFor(() => {
      const el = panelOf('Memory').querySelector<HTMLElement>('[data-panel-legend="table"]');
      expect(el, 'no legend').not.toBeNull();
      if (el === null) throw new Error('no legend');
      return el;
    });
    expect(seriesCount(t, 'Memory')).toBe(3);
    const user = userEvent.setup();
    await user.click(within(legend).getByRole('button', { name: '{instance="a"}' }));
    await waitFor(() => {
      expect(seriesCount(t, 'Memory')).toBe(1);
    });
    expect(frameOf(t, 'Memory')).toBeDefined();
    expect(t.range.mock.calls.length).toBe(calls);
    await user.click(within(legend).getByRole('button', { name: '{instance="a"}' }));
    await waitFor(() => {
      expect(seriesCount(t, 'Memory')).toBe(3);
    });
  });
});

describe('board stat tile (#64 Part B §4.4)', () => {
  const fmt = (x: number): string => formatValue(x, { kind: 'none' });
  const step = (state: Steps[number]['state'], value: number, label = '') => ({
    value,
    state,
    label,
  });
  it.each<[string, Vis['thresholds'] | undefined, number[], string | null, string | null, boolean]>(
    [
      ['S1', undefined, [1, 3, 1], null, null, false],
      [
        'S2',
        { direction: 'below', steps: [step('degraded', 1.5)] },
        [1, 3, 1],
        'degraded',
        `◉ ≤ ${fmt(1.5)}`,
        true,
      ],
      [
        'S3',
        { direction: 'above', steps: [step('watch', 1.5), step('failing', 4)] },
        [1, 3, 1],
        'ok',
        `◐ ≥ ${fmt(1.5)}`,
        false,
      ],
      [
        'S4',
        { direction: 'above', steps: [step('watch', 1.5, 'Warm')] },
        [NaN, NaN, NaN],
        'unknown',
        '◐ Warm',
        false,
      ],
    ],
  )('stat chip and threshold text %s', async (_id, thresholds, values, chip, text, crossed) => {
    const vis: Vis = thresholds === undefined ? { kind: 'stat' } : { kind: 'stat', thresholds };
    await openWith(
      { ...panel('p-2', 'Ratio', 'node_memory_free_bytes', 'stat'), vis },
      range([ser(1, { instance: 'a' }, values)]),
    );
    const p = panelOf('Ratio');
    const chipEl = p.querySelector<HTMLElement>('[data-stat-chip]');
    const textEl = p.querySelector<HTMLElement>('[data-stat-threshold]');
    if (chip === null) {
      expect(chipEl).toBeNull();
      expect(textEl).toBeNull();
      return;
    }
    expect(chipEl).toHaveAttribute('data-state', chip);
    expect(textEl?.textContent).toBe(text);
    expect(textEl?.hasAttribute('data-crossed')).toBe(crossed);
  });
});
