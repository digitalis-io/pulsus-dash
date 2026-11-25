/**
 * Recovery inside a real ChartFrame (plan #68 C1 §4.3, T03 §9.2): the routing engine swaps the
 * frame's canvas for a fresh one, hides the retired canvas (ChartFrame keeps its reference),
 * replays the frame's state, shows the notice and mirrors the title; nothing is left on unmount.
 * ChartFrame itself is unchanged.
 */
import { act, render, waitFor } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StubApi } from '../api/StubApi';
import { Providers } from '../app/providers';
import type { ChartFrame as EngineFrame, FrameData, FrameInit, VisSpec } from '../engine/api';
import { ChartEngineContext } from '../engine/index';
import { RoutingEngine, type WasmBackend } from '../engine/route';
import { createClock } from '../state/clock';
import { fakeEngine, type FakeEngine } from '../test/fakeEngine';
import { installResizeObserver, resizeAll } from '../test/fakeResizeObserver';
import { T } from '../test/renderApp';
import { ChartFrame } from './ChartFrame';

const URL0 = `/t/demo/x?from=2026-11-19T12:00:00.000Z&to=2026-11-19T13:00:00.000Z&refresh=off`;
const LINE: VisSpec = { kind: 'line', title: 'Requests', unit: { kind: 'none' } };
const DATA: FrameData = {
  kind: 'series',
  series: [
    {
      key: '00000000000000a1',
      labels: {},
      timestamps: new Float64Array([Date.UTC(2026, 10, 19, 12)]),
      values: new Float64Array([1]),
    },
  ],
};
const NOTICE = 'Recovered from an error: this chart uses the basic renderer.';

interface Backend extends WasmBackend {
  readonly inner: FakeEngine;
  readonly fails: ((reason: string) => void)[];
}

function backend(): Backend {
  const inner = fakeEngine();
  const fails: ((reason: string) => void)[] = [];
  return {
    tier: 't1',
    inner,
    fails,
    createFrame(canvas: OffscreenCanvas, init: FrameInit, onFail): EngineFrame {
      fails.push(onFail);
      return inner.createFrame(canvas as unknown as HTMLCanvasElement, init);
    },
  };
}

beforeEach(() => {
  installResizeObserver();
  Object.defineProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen', {
    configurable: true,
    value: () => ({ width: 0, height: 0 }) as unknown as OffscreenCanvas,
  });
});
afterEach(() => {
  Reflect.deleteProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen');
});

function mount(engine: RoutingEngine) {
  let setSpec: (s: VisSpec) => void = () => undefined;
  function Host() {
    const [spec, set] = useState(LINE);
    setSpec = set;
    return (
      <ChartEngineContext.Provider value={engine}>
        <ChartFrame spec={spec} data={DATA} />
      </ChartEngineContext.Provider>
    );
  }
  const router = createMemoryRouter([{ path: '/t/:tenant/x', element: <Host /> }], {
    initialEntries: [URL0],
  });
  const view = render(
    <Providers
      deps={{
        api: new StubApi(),
        queryClient: new QueryClient(),
        clock: createClock(() => T),
        timeZone: 'Europe/London',
      }}
    >
      <RouterProvider router={router} />
    </Providers>,
  );
  const host = (): HTMLElement => {
    const h = view.container.querySelector<HTMLElement>('[data-chart-frame]');
    if (h === null) throw new Error('no frame');
    return h;
  };
  return { view, host, setTitle: (title: string) => setSpec({ ...LINE, title }) };
}

function expectRetired(c: HTMLCanvasElement | undefined): void {
  if (c === undefined) throw new Error('no retired canvas');
  expect(c.hasAttribute('data-retired')).toBe(true);
  expect(c.hidden).toBe(true);
  expect(c.getAttribute('aria-hidden')).toBe('true');
  expect(getComputedStyle(c).display).toBe('none');
}

describe('ChartFrame engine recovery (T03 §9.2)', () => {
  it('a failed frame moves to Canvas 2D on a fresh canvas; a restart rebinds the engine', async () => {
    const b = backend();
    const c2d = fakeEngine();
    const { view, host, setTitle } = mount(new RoutingEngine(() => Promise.resolve(b), c2d));
    act(() => {
      resizeAll(900, 240);
    });
    await waitFor(() => {
      expect(b.inner.frames).toHaveLength(1);
    });
    const original = host().querySelector('canvas');
    expect(original?.dataset['engine']).toBe('wasm-webgpu');

    // A restart: a fresh canvas, transferred and bound again, with the state replayed.
    act(() => {
      b.fails[0]?.('restart');
    });
    await waitFor(() => {
      expect(b.inner.frames).toHaveLength(2);
    });
    let canvases = [...host().querySelectorAll('canvas')];
    expect(canvases).toHaveLength(2);
    expectRetired(canvases[0]);
    expect(canvases[0]).toBe(original);
    expect(canvases[1]?.dataset['engine']).toBe('wasm-webgpu');
    expect(b.inner.frames[1]?.last('setData')).toEqual([DATA]);
    expect(b.inner.frames[1]?.last('resize')).toEqual([900, 240, globalThis.devicePixelRatio]);
    expect(host().querySelector('[data-engine-notice]')?.textContent).toBe(NOTICE);

    // A frame failure: Canvas 2D on another fresh canvas, replayed, one notice.
    act(() => {
      b.fails[1]?.('surface');
    });
    canvases = [...host().querySelectorAll('canvas')];
    const live = canvases.filter((c) => !c.hasAttribute('data-retired'));
    expect(live).toHaveLength(1);
    for (const c of canvases.filter((x) => x.hasAttribute('data-retired'))) expectRetired(c);
    expect(live[0]?.dataset['engine']).toBe('canvas2d');
    expect(c2d.createCalls.map((c) => c.canvas)).toEqual(live);
    expect(c2d.frames[0]?.last('setSpec')).toEqual([LINE]);
    expect(c2d.frames[0]?.last('setData')).toEqual([DATA]);
    expect(c2d.frames[0]?.last('resize')).toEqual([900, 240, globalThis.devicePixelRatio]);
    expect(host().querySelectorAll('[data-engine-notice]')).toHaveLength(1);
    expect(live[0]?.getAttribute('role')).toBe('img');
    expect(live[0]?.className).toBe(original?.className);

    // ChartFrame labels its own canvas; the live one follows.
    act(() => {
      setTitle('Errors');
    });
    await waitFor(() => {
      expect(live[0]?.getAttribute('aria-label')).toBe('Errors');
    });

    view.unmount();
    expect(document.querySelectorAll('canvas')).toHaveLength(0);
    expect(document.querySelectorAll('[data-engine-notice]')).toHaveLength(0);
  });
});
