/**
 * `<ChartFrame>` with a bar chart (plan #173 Part 2 §4.4, §5 frame barchart; ADR-0028), and its
 * mirror listbox (Part 3a §3.2, ADR-0029: `unit:bar-list`, `unit:bar-list-selected`).
 */
import { act, screen } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BarchartSpec,
  FrameData,
  FrameSelection,
  FrameSummary,
  MarkEvent,
} from '../engine/api';
import { SelectionContext } from '../inspector/host';
import { categoryRows } from '../vis/reduce';
import { byVersion } from '../test/categoryFixtures';
import { lastFrame, renderChart } from '../test/chartFrameKit';
import { fakeEngine } from '../test/fakeEngine';
import { installResizeObserver, resizeAll } from '../test/fakeResizeObserver';
import { EMPTY_COVERAGE } from '../data/frames';
import { ChartFrame } from './ChartFrame';

beforeEach(() => {
  installResizeObserver();
});

const SPEC: BarchartSpec = {
  kind: 'barchart',
  title: 'Versions',
  unit: { kind: 'none' },
  orientation: 'horizontal',
  valueLabels: true,
  ghost: false,
  anomaly: false,
};
const ROWS = categoryRows(byVersion(), null, {
  reducer: 'last',
  categoryBy: '',
  sort: 'valueDesc',
  thresholds: { direction: 'above', steps: [{ value: 100, state: 'failing', label: '' }] },
}).rows;
const DATA: FrameData = {
  kind: 'categories',
  categories: ROWS,
  coverage: { ...EMPTY_COVERAGE, total: 6, drawn: 5 },
};
const PLOT = { x: 40, y: 8, width: 500, height: 200 };
const SUMMARY: FrameSummary = {
  kind: 'barchart',
  seriesTotal: 6,
  seriesShown: 5,
  fromMs: 0,
  toMs: 1,
  min: 3,
  max: 120,
  last: null,
  plot: PLOT,
  valueAxis: { min: 0, max: 150, manual: false },
  thresholdLabels: [],
  eventLabels: [],
  geo: null,
  coverage: { ...EMPTY_COVERAGE, total: 6, drawn: 5 },
};

describe('frame barchart', () => {
  it('no slider, no truncation notice; the label counts the bars', () => {
    const engine = fakeEngine();
    renderChart(engine, <ChartFrame spec={SPEC} data={DATA} />);
    act(() => {
      resizeAll(600, 240);
    });
    const f = lastFrame(engine);
    expect(screen.queryByRole('slider')).toBeNull();
    act(() => {
      f.emit('a11y', SUMMARY);
    });
    expect(screen.queryByText(/Showing 5 of 6/)).toBeNull();
    expect(f.canvas).toHaveAttribute('aria-label', 'Versions: 5 bars');
    expect(f.last('setData')?.[0]).toBe(DATA);
  });

  it('mark shows the tooltip; null hides it; pick reaches onPick', () => {
    const engine = fakeEngine();
    const onPick = vi.fn();
    renderChart(engine, <ChartFrame spec={SPEC} data={DATA} onPick={onPick} />);
    act(() => {
      resizeAll(600, 240);
    });
    const f = lastFrame(engine);
    act(() => {
      f.emit('a11y', SUMMARY);
    });
    const top = ROWS[0];
    if (top === undefined) throw new Error('no rows');
    const mark: MarkEvent = {
      source: 'pointer',
      key: top.key,
      index: 0,
      xCss: 300,
      yCss: 28,
      rows: [{ key: top.key, name: top.name, colourIndex: null, value: top.value }],
    };
    act(() => {
      f.emit('mark', mark);
    });
    const tip = document.querySelector('[data-mark-tooltip]');
    expect(tip).not.toBeNull();
    expect(tip).not.toHaveAttribute('hidden');
    expect(tip).toHaveTextContent('2.31');
    expect(tip).toHaveTextContent('120');
    expect(tip).toHaveTextContent('■ Failing');
    act(() => {
      f.emit('mark', null);
    });
    expect(tip).toHaveAttribute('hidden');
    const pick = { keys: [top.key], gesture: 'click', source: 'pointer' } as const;
    act(() => {
      f.emit('pick', pick);
    });
    expect(onPick).toHaveBeenCalledWith(pick, screen.getByRole('listbox'));
  });
});

const markAt = (i: number, source: MarkEvent['source']): MarkEvent => {
  const r = ROWS[i];
  if (r === undefined) throw new Error('no row');
  return {
    source,
    key: r.key,
    index: i,
    xCss: 300,
    yCss: 28 + 40 * i,
    rows: [{ key: r.key, name: r.name, colourIndex: null, value: r.value }],
  };
};

describe('unit:bar-list', () => {
  it('the listbox is the key target; its active option follows a keyboard mark', () => {
    const engine = fakeEngine();
    renderChart(engine, <ChartFrame spec={SPEC} data={DATA} />);
    act(() => {
      resizeAll(600, 240);
    });
    const f = lastFrame(engine);
    const list = screen.getByRole('listbox');
    expect(f.init.keyTarget).toBe(list);
    expect(list).toHaveAttribute('tabindex', '0');
    expect(list).toHaveAttribute('aria-multiselectable', 'true');
    expect(list).toHaveAttribute('data-escape-ladder');
    expect(list).not.toHaveAttribute('aria-activedescendant');
    act(() => {
      f.emit('a11y', SUMMARY);
      f.emit('mark', markAt(2, 'keyboard'));
    });
    const active = list.getAttribute('aria-activedescendant') ?? '';
    expect(active).toBe(`${list.id}-2`);
    expect(document.getElementById(active)).toHaveTextContent('2.33: 15');
    act(() => {
      f.emit('mark', markAt(1, 'pointer'));
    });
    expect(list).not.toHaveAttribute('aria-activedescendant');
    // `k more not shown` is outside the listbox, named by its description.
    const more = document.getElementById(`${list.id}-more`);
    expect(more).toHaveTextContent('1 more not shown');
    expect(list.contains(more)).toBe(false);
    expect(list).toHaveAttribute('aria-describedby', `${list.id}-more`);
    // The canvas's description resolves to the listbox: every bar, by name and value.
    const described = document.getElementById(f.canvas.getAttribute('aria-describedby') ?? '');
    expect(described).toBe(list);
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      '2.31: 120, Failing',
      '2.29: 40, OK',
      '2.33: 15, OK',
      '2.30: 7, OK',
      '2.32: 3, OK',
    ]);
    expect(screen.getAllByRole('option').map((o) => o.id)).toEqual(
      [0, 1, 2, 3, 4].map((i) => `${list.id}-${String(i)}`),
    );
  });
});

describe('unit:bar-list (review r1)', () => {
  it('a pointer mark then the keyboard mark again: the active option returns', () => {
    const engine = fakeEngine();
    renderChart(engine, <ChartFrame spec={SPEC} data={DATA} />);
    act(() => {
      resizeAll(600, 240);
    });
    const f = lastFrame(engine);
    const list = screen.getByRole('listbox');
    act(() => {
      f.emit('mark', markAt(1, 'keyboard'));
      f.emit('mark', markAt(3, 'pointer'));
    });
    expect(list).not.toHaveAttribute('aria-activedescendant');
    act(() => {
      f.emit('mark', markAt(1, 'keyboard'));
    });
    expect(list).toHaveAttribute('aria-activedescendant', `${list.id}-1`);
    expect(document.querySelector('[data-mark-tooltip]')).toHaveTextContent('2.29');
  });
});

describe('unit:bar-list-selected', () => {
  it('options are selected from the page selection; null selects none', () => {
    const engine = fakeEngine();
    let set: (s: FrameSelection | null) => void = () => undefined;
    function Host() {
      const [sel, setSel] = useState<FrameSelection | null>(null);
      set = setSel;
      return (
        <SelectionContext.Provider value={sel}>
          <ChartFrame spec={SPEC} data={DATA} />
        </SelectionContext.Provider>
      );
    }
    renderChart(engine, <Host />);
    act(() => {
      resizeAll(600, 240);
    });
    const selected = (): boolean[] =>
      screen.getAllByRole('option').map((o) => o.getAttribute('aria-selected') === 'true');
    expect(screen.getAllByRole('option')).toHaveLength(5);
    expect(selected()).toEqual([false, false, false, false, false]);
    act(() => {
      set({ keys: [ROWS[1]?.key ?? ''], fromMs: null, toMs: null });
    });
    expect(selected()).toEqual([false, true, false, false, false]);
    act(() => {
      set(null);
    });
    expect(selected()).toEqual([false, false, false, false, false]);
  });
});
