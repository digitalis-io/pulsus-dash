/**
 * `useBoardEvents` (plan #64 Part C §3.8, §4.1): one events request per resolved window for the
 * whole board, the previous one aborted, markers sorted by (atMs, id), none while disabled, and an
 * absolute Refresh now that aborts the request in flight and asks again.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Annotation, AnnotationList, PanelSpec } from '../api/types';
import { ABS, flush, openBoard, ready, T12, type Board } from '../test/boardPanelKit';
import { panel } from '../test/boardTestKit';
import {
  installIntersectionObserver,
  uninstallIntersectionObserver,
} from '../test/fakeIntersectionObserver';
import { installResizeObserver } from '../test/fakeResizeObserver';
import { StubApi } from '../api/StubApi';
import { Providers } from '../app/providers';
import { createClock } from '../state/clock';
import { T } from '../test/renderApp';
import { useBoardEvents, type BoardEvents } from './boardEvents';

vi.mock('../editor/editor', () => import('../test/fakeEditor'));

beforeEach(() => {
  installResizeObserver();
  installIntersectionObserver();
});

afterEach(() => {
  uninstallIntersectionObserver();
});

const thirty = (): PanelSpec[] =>
  Array.from({ length: 30 }, (_, i) => panel(`p-${String(i + 1)}`, `P${String(i + 1)}`, 'up'));

interface Held {
  readonly w: { fromMs: number; toMs: number };
  readonly signal: AbortSignal | undefined;
  resolve(v: AnnotationList): void;
}

/** From now on `listAnnotations` waits for the test. */
function hold(t: { api: StubApi }) {
  const held: Held[] = [];
  const spy = vi.spyOn(t.api, 'listAnnotations').mockImplementation((_tenant, w, signal) => {
    return new Promise<AnnotationList>((res, rej) => {
      signal?.addEventListener('abort', () => {
        rej(new DOMException('aborted', 'AbortError'));
      });
      held.push({ w, signal, resolve: res });
    });
  });
  return { held, spy };
}

/** Renders `hook` under the app's providers and a router on the board's absolute window. */
function renderHookInApp(api: StubApi, hook: () => BoardEvents) {
  const result: { current: BoardEvents } = {
    current: { markers: [], truncated: false, failed: false },
  };
  function Probe() {
    result.current = hook();
    return null;
  }
  const router = createMemoryRouter([{ path: '*', element: <Probe /> }], {
    initialEntries: [`/t/demo/x?${ABS}`],
  });
  const view = render(
    <Providers
      deps={{
        api,
        queryClient: new QueryClient(),
        clock: createClock(() => T),
        timeZone: 'Europe/London',
      }}
    >
      <RouterProvider router={router} />
    </Providers>,
  );
  return { result, unmount: view.unmount };
}

const note = (id: string, at: number): Annotation => ({
  id,
  at,
  end_at: null,
  kind: 'deploy',
  text: id,
  tags: [],
});

describe('board events', () => {
  it('one events request per window', async () => {
    const t: Board = openBoard(thirty());
    const h = hold(t);
    await ready('P1');
    await waitFor(() => {
      expect(h.spy).toHaveBeenCalledTimes(1);
    });
    const w1 = h.held[0];
    expect(w1?.w).toEqual({ fromMs: T12, toMs: T12 + 3_600_000 });
    await act(async () => {
      await t.router.navigate(`/t/demo/board/b-1?${ABS.replace('12:00:00', '11:00:00')}`);
    });
    await waitFor(() => {
      expect(h.spy).toHaveBeenCalledTimes(2);
    });
    expect(w1?.signal?.aborted).toBe(true);
    expect(h.held[1]?.w).toEqual({ fromMs: T12 - 3_600_000, toMs: T12 + 3_600_000 });
    await flush();
    expect(h.spy).toHaveBeenCalledTimes(2);

    // An absolute Refresh now: the request in flight is aborted, and one more is made.
    fireEvent.click(screen.getByRole('button', { name: 'Refresh now' }));
    await waitFor(() => {
      expect(h.spy).toHaveBeenCalledTimes(3);
    });
    expect(h.held[1]?.signal?.aborted).toBe(true);
    await flush();
    expect(h.spy).toHaveBeenCalledTimes(3);
  });

  it('markers sorted by (atMs, id); none while disabled', async () => {
    const api = new StubApi();
    vi.spyOn(api, 'listAnnotations').mockResolvedValue({
      items: [note('b', T12 + 5), note('c', T12 + 1), note('a', T12 + 5)],
      truncated: true,
    });
    const on = renderHookInApp(api, () => useBoardEvents('demo', true));
    await waitFor(() => {
      expect(on.result.current.markers.map((m) => m.id)).toEqual(['c', 'a', 'b']);
    });
    expect(on.result.current.truncated).toBe(true);
    expect(on.result.current.failed).toBe(false);
    expect(on.result.current.markers[0]).toEqual({
      id: 'c',
      atMs: T12 + 1,
      endMs: null,
      kind: 'deploy',
      title: 'c',
    });
    on.unmount();

    const off = new StubApi();
    const spy = vi.spyOn(off, 'listAnnotations');
    const disabled = renderHookInApp(off, () => useBoardEvents('demo', false));
    await flush();
    expect(spy).not.toHaveBeenCalled();
    expect(disabled.result.current.markers).toEqual([]);
    disabled.unmount();
  });
});
