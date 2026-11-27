/**
 * Recovery inside a real ChartFrame (plan #68 C1 §4.3, T03 §9.2): the routing engine swaps the
 * frame's canvas for a fresh one, hides the retired canvas (ChartFrame keeps its reference),
 * replays the frame's state, shows the notice and mirrors the title; a kind swap moves the frame
 * to Canvas 2D without a notice, for good; nothing is left on unmount. Canvas 2D is the real
 * engine on recording contexts. ChartFrame itself is unchanged.
 */
import { act, render, waitFor } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StubApi } from '../api/StubApi';
import { Providers } from '../app/providers';
import type { FrameData, FrameInit, VisSpec } from '../engine/api';
import type { EngineFrame } from '../engine/wasm/frame';
import { ChartEngineContext } from '../engine/index';
import { Canvas2DEngine } from '../engine/canvas2d/Canvas2DEngine';
import { RoutingEngine, type WasmBackend } from '../engine/route';
import { createClock } from '../state/clock';
import { fakeEngine, type FakeEngine, type FakeFrame } from '../test/fakeEngine';
import { installResizeObserver, resizeAll } from '../test/fakeResizeObserver';
import { recordingContext, type RecordingContext } from '../test/recordingContext';
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
const BARS: VisSpec = {
  kind: 'bars',
  title: 'Requests',
  unit: { kind: 'none' },
  stacking: 'normal',
  categoryLabel: 'level',
  categoryOrder: [],
};
const NOTICE = 'Recovered from an error: this chart uses the basic renderer.';

/** The real Canvas 2D engine on recording contexts, with a manual frame queue. */
function canvas2d() {
  const contexts = new Map<HTMLCanvasElement, RecordingContext>();
  /** The layer canvas of each frame, by its visible canvas. */
  const layers = new Map<HTMLCanvasElement, HTMLCanvasElement>();
  const queue: (() => void)[] = [];
  const layerSet = new Set<HTMLCanvasElement>();
  let visible: HTMLCanvasElement | null = null;
  const engine = new Canvas2DEngine({
    requestFrame: (cb) => queue.push(cb),
    cancelFrame: () => undefined,
    contextOf: (c) => {
      const r = recordingContext();
      contexts.set(c, r);
      if (!layerSet.has(c)) visible = c;
      return r;
    },
    createCanvas: () => {
      const l = document.createElement('canvas');
      layerSet.add(l);
      // The first canvas a frame creates is its layer; the second its dim layer (plan #68 C2c2).
      if (visible !== null && !layers.has(visible)) layers.set(visible, l);
      return l;
    },
    fonts: null,
    now: () => 0,
    setTimer: () => 0,
    clearTimer: () => undefined,
    wheelLatch: { lastPageWheel: () => -Infinity },
  });
  const created: HTMLCanvasElement[] = [];
  const wrapped = {
    createFrame: (c: HTMLCanvasElement, init: FrameInit) => {
      created.push(c);
      return engine.createFrame(c, init);
    },
  };
  return {
    engine: wrapped,
    created,
    flush() {
      for (let i = 0; i < 10 && queue.length > 0; i++) for (const cb of queue.splice(0)) cb();
    },
    /** Ops recorded on the layer of the frame drawn on `c`. */
    layerOps(c: HTMLCanvasElement | undefined, op: string): number {
      const l = c === undefined ? undefined : layers.get(c);
      return (l === undefined ? undefined : contexts.get(l))?.calls(op).length ?? 0;
    },
  };
}

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
      return inner.createFrame(canvas as unknown as HTMLCanvasElement, init) as FakeFrame;
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
  let setSpecOf: (s: VisSpec) => void = () => undefined;
  function Host() {
    const [spec, set] = useState(LINE);
    setSpecOf = set;
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
  return {
    view,
    host,
    setTitle: (title: string) => {
      setSpecOf({ ...LINE, title });
    },
    setSpec: (spec: VisSpec) => {
      setSpecOf(spec);
    },
  };
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
    const c2d = canvas2d();
    const { view, host, setTitle } = mount(new RoutingEngine(() => Promise.resolve(b), c2d.engine));
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
    expect(c2d.created).toEqual(live);
    // Replayed: Canvas 2D draws the line at the frame's size.
    act(() => {
      c2d.flush();
    });
    expect(c2d.layerOps(live[0], 'stroke')).toBeGreaterThan(0);
    expect(host().querySelectorAll('[data-engine-notice]')).toHaveLength(1);
    expect(live[0]?.getAttribute('role')).toBe('img');
    expect(live[0]?.className).toBe(original?.className);

    // ChartFrame labels its own canvas; the live one follows.
    act(() => {
      setTitle('Errors');
    });
    await waitFor(() => {
      expect(live[0]?.getAttribute('aria-label')).toMatch(/^Errors: line chart/);
      expect(live[0]?.getAttribute('aria-label')).toBe(original?.getAttribute('aria-label'));
    });

    view.unmount();
    expect(document.querySelectorAll('canvas')).toHaveLength(0);
    expect(document.querySelectorAll('[data-engine-notice]')).toHaveLength(0);
  });

  it('a kind swap moves the frame to Canvas 2D without a notice, and it stays there', async () => {
    const b = backend();
    const c2d = canvas2d();
    let transfers = 0;
    Object.defineProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen', {
      configurable: true,
      value: () => {
        transfers += 1;
        return { width: 0, height: 0 } as unknown as OffscreenCanvas;
      },
    });
    const { view, host, setSpec } = mount(new RoutingEngine(() => Promise.resolve(b), c2d.engine));
    act(() => {
      resizeAll(900, 240);
    });
    await waitFor(() => {
      expect(b.inner.frames).toHaveLength(1);
    });
    act(() => {
      setSpec(BARS);
    });
    const canvases = [...host().querySelectorAll('canvas')];
    expect(canvases).toHaveLength(2);
    expectRetired(canvases[0]);
    const live = canvases[1];
    expect(live?.dataset['engine']).toBe('canvas2d');
    expect(b.inner.frames[0]?.disposed).toBe(1);
    act(() => {
      c2d.flush();
    });
    expect(c2d.layerOps(live, 'fillRect')).toBeGreaterThan(0);
    expect(host().querySelector('[data-engine-notice]')).toBeNull();
    act(() => {
      setSpec(LINE);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(transfers).toBe(1);
    expect(b.inner.frames).toHaveLength(1);
    expect(host().querySelectorAll('canvas:not([data-retired])')[0]).toBe(live);
    view.unmount();
    expect(document.querySelectorAll('canvas')).toHaveLength(0);
  });
});
