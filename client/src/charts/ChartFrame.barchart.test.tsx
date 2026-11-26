/** `<ChartFrame>` with a bar chart (plan #173 Part 2 §4.4, §5 frame barchart; ADR-0028). */
import { act, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BarchartSpec, FrameData, FrameSummary, MarkEvent } from '../engine/api';
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
  coverage: { ...EMPTY_COVERAGE, total: 6, drawn: 5 },
};

describe('frame barchart', () => {
  it('no slider, no key target, no truncation notice; the label counts the bars', () => {
    const engine = fakeEngine();
    renderChart(engine, <ChartFrame spec={SPEC} data={DATA} />);
    act(() => {
      resizeAll(600, 240);
    });
    const f = lastFrame(engine);
    expect(f.init.keyTarget).toBeNull();
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
    act(() => {
      f.emit('pick', { keys: [top.key], gesture: 'click' });
    });
    expect(onPick).toHaveBeenCalledWith({ keys: [top.key], gesture: 'click' });
  });
});
