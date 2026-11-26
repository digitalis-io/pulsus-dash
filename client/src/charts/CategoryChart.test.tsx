/**
 * `<CategoryChart>` (plan #173 Part 2 §4.1, §5): the fit per cell size, the frame or the `tooSmall`
 * notice, the hidden-labels note and the meter. The offscreen measure is 6 px per character.
 */
import { act, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BOTTOM, LABEL_HEIGHT } from '../engine/canvas2d/layout';
import { byVersion, fkey, instant } from '../test/categoryFixtures';
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
    size(610, 245);
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
