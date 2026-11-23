import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PanelSpec } from '../../api/types';
import type { LayoutItem } from '../../boards/editorState';
import { cellPx } from '../../boards/layout';
import { installResizeObserver, resizeAll } from '../../test/fakeResizeObserver';
import { BoardGrid } from './BoardGrid';

function panel(id: string, x: number, y: number): PanelSpec {
  return {
    id,
    title: id,
    grid: { x, y, w: 6, h: 8 },
    query: { lang: 'promql', text: 'up' },
    vis: { kind: 'line' },
  };
}

const PANELS = [panel('A', 0, 0), panel('B', 6, 0), panel('C', 0, 8)];
const WIDTH = 1152;

/** A grid item's offset from its transform (jsdom has no layout). */
function offsetOf(el: Element): { left: number; top: number } {
  // jsdom prints `translate(584px)` when y is 0.
  const m = /translate\((-?[\d.]+)px(?:,\s*(-?[\d.]+)px)?\)/.exec(
    (el as HTMLElement).style.transform,
  );
  return { left: Number(m?.[1] ?? 0), top: Number(m?.[2] ?? 0) };
}

/** jsdom layout stand-ins: grid items report their transform as their box; parents are offsetParents. */
function installLayout(): () => void {
  const rect = Object.getOwnPropertyDescriptor(Element.prototype, 'getBoundingClientRect');
  const parent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent');
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const item = this.closest('.react-grid-item');
    const { left, top } = item === null ? { left: 0, top: 0 } : offsetOf(item);
    return DOMRect.fromRect({ x: left, y: top, width: 0, height: 0 });
  };
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get(this: HTMLElement) {
      return this.parentElement;
    },
  });
  return () => {
    if (rect !== undefined) Object.defineProperty(Element.prototype, 'getBoundingClientRect', rect);
    if (parent !== undefined) Object.defineProperty(HTMLElement.prototype, 'offsetParent', parent);
  };
}

function item(id: string): HTMLElement {
  const el = screen.getByText(id).closest<HTMLElement>('.react-grid-item');
  if (el === null) throw new Error(`no grid item ${id}`);
  return el;
}

/** Drags `id`'s handle by (dx, dy) px in 10 steps. */
function drag(id: string, dx: number, dy: number): void {
  const handle = screen.getByText(id);
  const { left, top } = offsetOf(item(id));
  const x0 = left + 10;
  const y0 = top + 10;
  fireEvent.mouseDown(handle, { clientX: x0, clientY: y0, button: 0 });
  for (let i = 1; i <= 10; i++) {
    fireEvent.mouseMove(document, { clientX: x0 + (dx * i) / 10, clientY: y0 + (dy * i) / 10 });
  }
  fireEvent.mouseUp(document, { clientX: x0 + dx, clientY: y0 + dy });
}

let restore: () => void = () => undefined;
beforeEach(() => {
  installResizeObserver();
  restore = installLayout();
});
afterEach(() => {
  restore();
});

describe('BoardGrid', () => {
  it('mounts under React 19 without errors', async () => {
    const error = vi.spyOn(console, 'error');
    const onLayout = vi.fn();
    const onBlocked = vi.fn();
    const view = render(
      <BoardGrid
        mode="edit"
        panels={PANELS}
        readOnly={false}
        onLayout={onLayout}
        onBlocked={onBlocked}
        renderPanel={(p) => <div data-drag-handle="">{p.id}</div>}
      />,
    );
    await act(async () => {
      resizeAll(WIDTH, 800);
      await new Promise((r) => requestAnimationFrame(r));
    });
    const cell = cellPx(WIDTH);
    expect(cell).toBeCloseTo(81.333, 2);
    expect(offsetOf(item('B')).left).toBeCloseTo(6 * (cell + 16), 1);
    expect(offsetOf(item('C')).top).toBe(8 * 56);
    expect(parseFloat(item('A').style.width)).toBeCloseTo(6 * cell + 5 * 16, 1);

    // Each fireEvent is its own act(), so React renders between the pointer events.
    drag('C', 6 * (cell + 16), 0);
    expect(onLayout).toHaveBeenCalledTimes(1);
    const items = (onLayout.mock.calls[0]?.[0] ?? []) as LayoutItem[];
    expect(items.map((l) => [l.i, l.x, l.y, l.w, l.h])).toEqual([['C', 6, 8, 6, 8]]);

    drag('B', -6 * (cell + 16), 0);
    expect(onLayout).toHaveBeenCalledTimes(1);
    expect(offsetOf(item('B')).left).toBeCloseTo(6 * (cell + 16), 1);
    expect(offsetOf(item('A')).left).toBe(0);

    view.unmount();
    expect(error).not.toHaveBeenCalled();
  });

  it('View mode: the same items, (y, x) order, no drag and no resize handle', async () => {
    const onLayout = vi.fn();
    const renderPanel = (p: PanelSpec) => <div data-drag-handle="">{p.id}</div>;
    // C before B in the draft; View mode reads (y, x).
    const draft = [PANELS[0], PANELS[2], PANELS[1]].filter((p) => p !== undefined);
    const view = render(
      <BoardGrid
        mode="view"
        panels={draft}
        readOnly={false}
        onLayout={onLayout}
        onBlocked={vi.fn()}
        renderPanel={renderPanel}
      />,
    );
    await act(async () => {
      resizeAll(WIDTH, 800);
      await new Promise((r) => requestAnimationFrame(r));
    });
    const order = () =>
      [...document.querySelectorAll('.react-grid-item')].map((e) => e.textContent);
    expect(order()).toEqual(['A', 'B', 'C']);
    expect(document.querySelector('.react-resizable-handle')).toBeNull();
    const b = item('B');
    drag('B', 0, 16 * 56);
    expect(onLayout).not.toHaveBeenCalled();

    view.rerender(
      <BoardGrid
        mode="edit"
        panels={draft}
        readOnly={false}
        onLayout={onLayout}
        onBlocked={vi.fn()}
        renderPanel={renderPanel}
      />,
    );
    // The draft's order in Edit mode; the same elements.
    expect(order()).toEqual(['A', 'C', 'B']);
    expect(item('B')).toBe(b);
    expect(document.querySelectorAll('.react-resizable-handle')).toHaveLength(3);
  });
});
