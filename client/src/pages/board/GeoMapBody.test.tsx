/**
 * `unit:geo-chunk-failed` (T24-095; plan #234 Part 3 §4.10): a board with a geomap and a line panel;
 * the `GeoMapFrame` chunk's import rejects once (Retry remounts the boundary and imports again) or
 * twice (Reload). The line panel and the header stay usable throughout.
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installIntersectionObserver,
  uninstallIntersectionObserver,
} from '../../test/fakeIntersectionObserver';
import { installResizeObserver } from '../../test/fakeResizeObserver';
import { panel } from '../../test/boardTestKit';
import { openBoard, ready, show } from '../../test/boardPanelKit';
import { geoMapChunk } from './GeoMapBody';

vi.mock('../../editor/editor', () => import('../../test/fakeEditor'));

beforeEach(() => {
  installResizeObserver();
  installIntersectionObserver();
});
afterEach(() => {
  uninstallIntersectionObserver();
  vi.restoreAllMocks();
});

const PANELS = [
  { ...panel('p-1', 'Map', 'up'), vis: { kind: 'geomap' as const } },
  { ...panel('p-2', 'Line', 'up'), vis: { kind: 'line' as const } },
];

async function flushAll(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

describe('unit:geo-chunk-failed', () => {
  it('(a) reject, then resolve: the error with Retry, the line panel renders; Retry imports again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const real = geoMapChunk.load;
    // The chunk fails until Retry (the board may mount the panel more than once meanwhile).
    let failing = true;
    const load = vi
      .spyOn(geoMapChunk, 'load')
      .mockImplementation(() => (failing ? Promise.reject(new Error('chunk failed')) : real()));
    openBoard(PANELS);
    await ready('Map', 'Line');
    show('Map', 'Line');
    await flushAll();
    expect(await screen.findByText("Map couldn't load")).not.toBeNull();
    expect(screen.getByRole('heading', { level: 3, name: 'Line' })).not.toBeNull();
    const map = document.querySelector('[data-panel-id="p-1"]');
    expect(map?.querySelector('[data-geomap]')).toBeNull();
    const before = load.mock.calls.length;
    failing = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await flushAll();
    // A new boundary and a second import.
    expect(load.mock.calls.length).toBeGreaterThan(before);
    expect(screen.queryByText("Map couldn't load")).toBeNull();
    await waitFor(() => {
      expect(map?.querySelector('[data-geomap]')).not.toBeNull();
    });
  });

  it('(b) reject twice: after Retry the Reload text and button', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(geoMapChunk, 'load').mockImplementation(() =>
      Promise.reject(new Error('chunk failed')),
    );
    const reload = vi.spyOn(geoMapChunk, 'reload').mockImplementation(() => undefined);
    openBoard(PANELS);
    await ready('Map', 'Line');
    show('Map', 'Line');
    await flushAll();
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await flushAll();
    expect(
      await screen.findByText("Map couldn't load. Reload the page to try again."),
    ).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
