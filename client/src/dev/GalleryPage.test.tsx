/**
 * The gallery's bar charts (plan #173 Part 3a §2, §5 `unit:bar-list-selected` and gallery table):
 * one listbox per bar chart, none selected, and a per-entry table flag that Shift+T toggles.
 */
import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lastFrame, renderChart } from '../test/chartFrameKit';
import { fakeEngine } from '../test/fakeEngine';
import { installResizeObserver, resizeAll } from '../test/fakeResizeObserver';
import { GalleryPage } from './GalleryPage';

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

function gallery() {
  const engine = fakeEngine();
  renderChart(engine, <GalleryPage />);
  act(() => {
    resizeAll(600, 240);
  });
  return engine;
}

const entry = (id: string): Element => {
  const el = document.querySelector(`[data-gallery-id="${id}"]`);
  if (el === null) throw new Error(`no ${id}`);
  return el;
};

describe('unit:bar-list-selected (gallery)', () => {
  it('every bar chart has one listbox at first paint, none selected', () => {
    gallery();
    const lists = screen.getAllByRole('listbox');
    expect(lists).toHaveLength(5);
    for (const l of lists) {
      expect(l.querySelectorAll('[role=option][aria-selected="true"]')).toHaveLength(0);
    }
  });
});

describe('gallery table', () => {
  it("Shift+T opens one entry's table and closes it back to its listbox", () => {
    const engine = gallery();
    expect(lastFrame(engine)).toBeDefined();
    const list = entry('barchart').querySelector<HTMLElement>('[role=listbox]');
    if (list === null) throw new Error('no listbox');
    act(() => {
      list.focus();
      fireEvent.keyDown(list, { key: 'T', shiftKey: true });
    });
    expect(entry('barchart').querySelector('[role=grid]')).not.toBeNull();
    expect(screen.getAllByRole('grid')).toHaveLength(1);
    expect(screen.getAllByRole('listbox')).toHaveLength(4);
    const grid = screen.getByRole('grid');
    act(() => {
      fireEvent.keyDown(grid, { key: 'T', shiftKey: true });
    });
    expect(screen.queryByRole('grid')).toBeNull();
    const again = entry('barchart').querySelector('[role=listbox]');
    expect(document.activeElement).toBe(again);
  });
});
