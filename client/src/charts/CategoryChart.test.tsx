/**
 * `<CategoryChart>` (plan #173 Part 2 §4.1, §5): the fit per cell size, the frame or the `tooSmall`
 * notice, the hidden-labels note and the meter. The offscreen measure is 6 px per character.
 */
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BOTTOM, LABEL_HEIGHT } from '../engine/canvas2d/layout';
import { byVersion, fkey, instant, many } from '../test/categoryFixtures';
import { lastFrame, renderChart } from '../test/chartFrameKit';
import { fakeEngine } from '../test/fakeEngine';
import { installResizeObserver, resizeOf } from '../test/fakeResizeObserver';
import { barchartModel, type BarchartModel } from '../vis/barchart';
import type { ExploreResult } from '../vis/autovis';
import { CategoryChart } from './CategoryChart';

type Result = Exclude<ExploreResult, { kind: 'string' }>;

beforeEach(() => {
  installResizeObserver();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () =>
      ({
        font: '',
        measureText: (t: string) => ({ width: 6 * Array.from(t).length }),
      }) as unknown as CanvasRenderingContext2D,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

function model(r: ExploreResult = byVersion(), options = {}): BarchartModel {
  return barchartModel(r as Result, {
    title: 'Versions',
    rateApplied: false,
    options,
    thresholds: null,
  });
}

function mount(m: BarchartModel) {
  const engine = fakeEngine();
  renderChart(engine, <CategoryChart model={m} title="Versions" onNarrow={vi.fn()} />);
  const cell = document.querySelector('[data-category-cell]');
  if (cell === null) throw new Error('no cell');
  const size = (w: number, h: number): void => {
    act(() => {
      resizeOf(cell, w, h);
    });
  };
  return { engine, size };
}

const note = (): string | null => document.querySelector('[data-hidden-note]')?.textContent ?? null;
const meter = (): string | null =>
  document.querySelector('[data-coverage-meter]')?.textContent ?? null;
const frames = (): number => document.querySelectorAll('[data-chart-frame]').length;

describe('unit:barchart-fit-stages (CategoryChart)', () => {
  it('horizontal: the matching note, then the tooSmall notice without a frame', () => {
    const { size } = mount(model());
    size(130, 240);
    expect(frames()).toBe(1);
    expect(note()).toBeNull();
    expect(meter()).toBe('100 %');
    size(100, 240);
    expect(note()).toBe('Names hidden — panel too narrow');
    size(80, 240);
    expect(note()).toBe('Names and values hidden — panel too narrow');
    size(60, 240);
    expect(frames()).toBe(0);
    expect(document.querySelector('[data-too-small]')).toHaveTextContent(
      'too small: 5 bars (min 2.32 3, max 2.31 120)',
    );
    expect(meter()).toBe('showing 0 of 5');
  });

  it('vertical: the same stages by height', () => {
    const { size } = mount(model(byVersion(), { orientation: 'vertical' }));
    size(600, 88 + LABEL_HEIGHT);
    expect(note()).toBeNull();
    size(600, 87 + LABEL_HEIGHT);
    expect(note()).toBe('Names hidden — panel too narrow');
    size(600, 55 + LABEL_HEIGHT);
    expect(note()).toBe('Names and values hidden — panel too narrow');
    size(600, 55);
    expect(frames()).toBe(0);
  });
});

describe('unit:barchart-labels (CategoryChart)', () => {
  it('names that cannot fit are hidden with the note', () => {
    const r = instant([
      { key: fkey(1), labels: { svc: 'svc-alpha-checkout-service-eu-west' }, value: 2 },
      { key: fkey(2), labels: { svc: 'svc-alpha-payments-service-eu-west' }, value: 1 },
    ]);
    const { size } = mount(model(r, { orientation: 'vertical' }));
    // Vertical: band ⌊0.4 · 70⌋ = 28, room 20 < 24 (`MMMM`); the plot keeps 70 − 8 − 14 = 48.
    size(600, 70);
    expect(note()).toBe('Names hidden — panel too narrow');
  });
});

describe('unit:barchart-plan (CategoryChart)', () => {
  it('a resize within one cap and stage keeps the frame data', () => {
    const { engine, size } = mount(model());
    size(600, 240);
    const f = lastFrame(engine);
    const before = f.calls.filter((c) => c.method === 'setData').length;
    const data = f.last('setData')?.[0];
    size(610, 241);
    expect(f.calls.filter((c) => c.method === 'setData')).toHaveLength(before);
    expect(f.last('setData')?.[0]).toBe(data);
    expect(f.last('setSpec')?.[0]).toMatchObject({ kind: 'barchart', title: 'Versions' });
  });

  it('tooSmall at a 20 px extent', () => {
    const { size } = mount(model());
    size(600, 20 + 8 + BOTTOM);
    expect(frames()).toBe(0);
    expect(screen.getByText('too small: 5 bars (min 2.32 3, max 2.31 120)')).toBeInTheDocument();
  });
});

describe('bar list (review r1: the bars for assistive technology)', () => {
  const items = (): string[] =>
    [
      ...document.querySelectorAll(
        '[data-bar-list] [role=option], [data-bar-list] + [id$="-more"]',
      ),
    ].map((li) => li.textContent);

  it('names every drawn bar in full with its value, then the bars not shown', () => {
    const { engine, size } = mount(model());
    size(600, 240);
    const list = document.querySelector('[data-bar-list]');
    expect(list).toHaveAttribute('role', 'listbox');
    expect(lastFrame(engine).canvas).toHaveAttribute('aria-describedby', list?.id ?? 'none');
    expect(items()).toEqual(['2.31: 120', '2.29: 40', '2.33: 15', '2.30: 7', '2.32: 3']);
    // One tab stop: the listbox itself (ADR-0029); its options are not focusable.
    expect(list?.querySelectorAll('[tabindex], a, button')).toHaveLength(0);
    // A cap of 2 (extent 28 px): min and max, then the rest counted.
    size(600, 28 + 8 + BOTTOM);
    expect(items()).toEqual(['2.31: 120', '2.32: 3', '3 more not shown']);
  });

  it('keeps names the canvas hides, and states with thresholds', () => {
    const r = instant([
      { key: fkey(1), labels: { svc: 'svc-alpha-checkout-service-eu-west' }, value: 2 },
      { key: fkey(2), labels: { svc: 'svc-alpha-payments-service-eu-west' }, value: 1 },
    ]);
    const { size } = mount(model(r, { orientation: 'vertical' }));
    size(600, 70);
    expect(note()).toBe('Names hidden — panel too narrow');
    expect(items()).toEqual([
      'svc-alpha-checkout-service-eu-west: 2',
      'svc-alpha-payments-service-eu-west: 1',
    ]);
    const t = barchartModel(byVersion() as Result, {
      title: 'Versions',
      rateApplied: false,
      options: undefined,
      thresholds: { direction: 'above', steps: [{ value: 100, state: 'failing', label: '' }] },
    });
    cleanup();
    const again = mount(t);
    again.size(600, 240);
    expect(items()[0]).toBe('2.31: 120, Failing');
    expect(items()[1]).toBe('2.29: 40, OK');
  });
});

/** A caller that keeps the table flag, as a board panel or the gallery does (plan §3.6). */
function mountTable(m: BarchartModel, o: { ghost?: boolean; baselineFailed?: boolean } = {}) {
  const engine = fakeEngine();
  function Caller() {
    const [table, setTable] = useState(false);
    return (
      <CategoryChart
        model={m}
        title="Versions"
        onNarrow={vi.fn()}
        table={table}
        onTable={setTable}
        {...(o.ghost === undefined ? {} : { ghost: o.ghost })}
        {...(o.baselineFailed === undefined ? {} : { baselineFailed: o.baselineFailed })}
      />
    );
  }
  renderChart(engine, <Caller />);
  const cell = document.querySelector('[data-category-cell]');
  if (cell === null) throw new Error('no cell');
  const size = (w: number, h: number): void => {
    act(() => {
      resizeOf(cell, w, h);
    });
  };
  const shiftT = (el: Element): boolean => {
    let passed = true;
    act(() => {
      passed = fireEvent.keyDown(el, { key: 'T', shiftKey: true });
    });
    return passed;
  };
  return { engine, size, shiftT };
}

describe('unit:category-chart-table', () => {
  it('Shift+T swaps the chart and the table; focus follows; inputs and no onTable are left alone', () => {
    const { engine, size, shiftT } = mountTable(model(), { ghost: true, baselineFailed: true });
    size(600, 240);
    expect(lastFrame(engine).last('setSpec')?.[0]).toMatchObject({ ghost: true });
    expect(screen.getByText('Baseline unavailable: the shifted query failed.')).toBeInTheDocument();
    expect(shiftT(screen.getByRole('listbox'))).toBe(false);
    expect(frames()).toBe(0);
    const grid = screen.getByRole('grid', { name: 'Versions' });
    expect(document.activeElement).toBe(grid);
    shiftT(grid);
    expect(frames()).toBe(1);
    expect(screen.queryByRole('grid')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('listbox'));

    const root = document.querySelector('[data-category-chart]');
    const input = document.createElement('input');
    root?.appendChild(input);
    expect(shiftT(input)).toBe(true);
    expect(frames()).toBe(1);
    input.remove();

    cleanup();
    const plain = mount(model());
    plain.size(600, 240);
    expect(shiftT(screen.getByRole('listbox'))).toBe(true);
    expect(frames()).toBe(1);
  });
});

describe('unit:category-tiny (table)', () => {
  it('the tooSmall notice is focusable and Shift+T from it lists every row', async () => {
    const rows = many();
    const r = instant(rows.map((x) => ({ key: x.key, labels: x.labels, value: x.value })));
    const m = { ...model(r), all: rows };
    const { size, shiftT } = mountTable(m);
    size(600, 20 + 8 + BOTTOM);
    expect(frames()).toBe(0);
    await userEvent.setup().tab();
    const notice = screen.getByRole('group', {
      name: 'Versions: panel too small — press Shift+T for the table',
    });
    expect(document.activeElement).toBe(notice);
    shiftT(notice);
    const grid = screen.getByRole('grid', { name: 'Versions' });
    expect(grid).toHaveAttribute('aria-rowcount', '251');
    expect(screen.getByText('250 rows · 0 drawn')).toBeInTheDocument();
    expect(document.activeElement).toBe(grid);
    shiftT(grid);
    expect(document.activeElement).toBe(
      screen.getByRole('group', {
        name: 'Versions: panel too small — press Shift+T for the table',
      }),
    );
  });
});
