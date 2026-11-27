// unit:chart-inspect (T25-005, T25-006, plan #192 §4.3, §5): ChartFrame's inspect props, the
// selection it hands the engine and the stat's inspect button.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StubApi } from '../api/StubApi';
import { Providers } from '../app/providers';
import type { RouterDeps } from '../app/router';
import type { FrameData, FrameSelection, HoverEvent, VisSpec } from '../engine/api';
import { ChartEngineContext } from '../engine/index';
import { SelectionContext } from '../inspector/host';
import { createClock } from '../state/clock';
import { fakeEngine, type FakeEngine, type FakeFrame } from '../test/fakeEngine';
import { installResizeObserver } from '../test/fakeResizeObserver';
import { T } from '../test/renderApp';
import type { InspectorTarget } from '../inspector/types';
import { frameOf as geoFrameOf, geoSpec } from '../test/geoKit';
import { G, TH } from '../vis/geo/fixtures/series';
import { ChartFrame, type ChartFrameProps } from './ChartFrame';
import { selectionOf } from './inspectTarget';

const FROM = Date.UTC(2026, 10, 19, 12);
const URL0 = `/t/demo/x?from=2026-11-19T12:00:00.000Z&to=2026-11-19T13:00:00.000Z&refresh=off`;
const K1 = '00000000000000a1';
const K2 = '00000000000000a2';
const LINE: VisSpec = { kind: 'line', title: 'T', unit: { kind: 'none' } };
const STAT: VisSpec = { kind: 'stat', title: 'T', unit: { kind: 'none' } };
const DATA: FrameData = {
  kind: 'series',
  series: [
    {
      key: K1,
      labels: { a: '1' },
      timestamps: new Float64Array([FROM]),
      values: new Float64Array([1]),
    },
    {
      key: K2,
      labels: { a: '2' },
      timestamps: new Float64Array([FROM]),
      values: new Float64Array([5]),
    },
  ],
};

beforeEach(() => {
  installResizeObserver();
});

function renderInspect(
  engine: FakeEngine,
  spec: VisSpec,
  p: Partial<ChartFrameProps>,
  selection: FrameSelection | null = null,
) {
  const deps: RouterDeps = {
    api: new StubApi(),
    queryClient: new QueryClient(),
    clock: createClock(() => T),
    timeZone: 'Europe/London',
  };
  const router = createMemoryRouter(
    [
      {
        path: '/t/:tenant/x',
        element: (
          <ChartEngineContext.Provider value={engine}>
            <SelectionContext.Provider value={selection}>
              <ChartFrame spec={spec} data={DATA} {...p} />
            </SelectionContext.Provider>
          </ChartEngineContext.Provider>
        ),
      },
    ],
    { initialEntries: [URL0] },
  );
  return render(
    <Providers deps={deps}>
      <RouterProvider router={router} />
    </Providers>,
  );
}

async function frameOf(engine: FakeEngine): Promise<FakeFrame> {
  await waitFor(() => {
    expect(engine.frames.length).toBeGreaterThan(0);
  });
  const f = engine.frames.at(-1);
  if (f === undefined) throw new Error('no frame');
  return f;
}

describe('unit:chart-inspect', () => {
  it('a select item inspects; an empty click clears', async () => {
    const engine = fakeEngine();
    const onInspect = vi.fn();
    const onEmptyClick = vi.fn();
    renderInspect(engine, LINE, { onInspect, onEmptyClick });
    const f = await frameOf(engine);
    act(() => {
      f.emit('select', {
        source: 'pointer',
        item: { kind: 'point', key: K1, tMs: FROM, value: 1 },
      });
    });
    const slider = screen.getByRole('slider');
    expect(onInspect).toHaveBeenCalledTimes(1);
    expect(onInspect.mock.calls[0]?.[0]).toMatchObject({
      type: 'point',
      key: K1,
      tMs: FROM,
      value: 1,
    });
    expect(onInspect.mock.calls[0]?.[1]).toBe('pointer');
    expect(onInspect.mock.calls[0]?.[2]).toBe(slider);
    act(() => {
      f.emit('select', { source: 'pointer', item: null });
    });
    expect(onEmptyClick).toHaveBeenCalledTimes(1);
  });

  it('Enter on the keyboard crosshair inspects the selected row', async () => {
    const engine = fakeEngine();
    const onInspect = vi.fn();
    renderInspect(engine, LINE, { onInspect });
    const f = await frameOf(engine);
    const hover: HoverEvent = {
      source: 'keyboard',
      tMs: FROM,
      xCss: 10,
      yCss: 0,
      rows: [
        { key: K1, name: 'a', colourIndex: 1, value: 1 },
        { key: K2, name: 'b', colourIndex: 2, value: 5 },
      ],
    };
    act(() => {
      f.emit('hover', hover);
    });
    const slider = screen.getByRole('slider');
    // sortedRows: value descending → K2 first; ArrowDown selects K1.
    fireEvent.keyDown(slider, { key: 'ArrowDown' });
    const e = fireEvent.keyDown(slider, { key: 'Enter' });
    expect(e).toBe(false);
    expect(onInspect).toHaveBeenCalledTimes(1);
    expect(onInspect.mock.calls[0]?.[0]).toMatchObject({ type: 'point', key: K1, value: 1 });
    expect(onInspect.mock.calls[0]?.[1]).toBe('keyboard');
    expect(onInspect.mock.calls[0]?.[2]).toBe(slider);
    fireEvent.keyDown(slider, { key: ' ' });
    expect(onInspect).toHaveBeenCalledTimes(2);
  });

  it('stat: an "Inspect <title>" button over the frame', async () => {
    const engine = fakeEngine();
    const onInspect = vi.fn();
    renderInspect(engine, STAT, { onInspect });
    await frameOf(engine);
    const b = screen.getByRole('button', { name: 'Inspect T' });
    fireEvent.click(b, { detail: 1 });
    expect(onInspect.mock.calls[0]?.[0]).toMatchObject({ type: 'value', key: K1, value: 1 });
    expect(onInspect.mock.calls[0]?.[1]).toBe('pointer');
    expect(onInspect.mock.calls[0]?.[2]).toBe(b);
    fireEvent.click(b, { detail: 0 });
    expect(onInspect.mock.calls[1]?.[1]).toBe('keyboard');
  });

  it('the selection goes to the engine and the host attribute', async () => {
    const engine = fakeEngine();
    const sel = { keys: [K1], fromMs: null, toMs: null };
    renderInspect(engine, LINE, {}, sel);
    const f = await frameOf(engine);
    await waitFor(() => {
      expect(f.last('setSelection')).toEqual([sel]);
    });
    expect(document.querySelector('[data-chart-frame]')).toHaveAttribute('data-selection-keys', K1);
  });

  it('without onInspect: no stat button, Enter is ignored', async () => {
    const engine = fakeEngine();
    renderInspect(engine, STAT, {});
    await frameOf(engine);
    expect(screen.queryByRole('button', { name: 'Inspect T' })).toBeNull();
    expect(document.querySelector('[data-chart-frame]')).toHaveAttribute('data-selection-keys', '');
    const e2 = fakeEngine();
    const { unmount } = renderInspect(e2, LINE, {});
    const f = await frameOf(e2);
    act(() => {
      f.emit('hover', {
        source: 'keyboard',
        tMs: FROM,
        xCss: 10,
        yCss: 0,
        rows: [{ key: K1, name: 'a', colourIndex: 1, value: 1 }],
      });
    });
    const sliders = screen.getAllByRole('slider');
    expect(fireEvent.keyDown(sliders.at(-1) ?? document.body, { key: 'Enter' })).toBe(true);
    unmount();
  });
});

describe('unit:geo-select-hover (INT-034, T24-088; plan #234 Part 3 §3.2)', () => {
  const geoData = (): FrameData => ({ kind: 'geo', geo: geoFrameOf(G(), { th: TH }) });

  it('select at cluster:k03 → the cluster target and its keys; hover on k05 → the geo tooltip', async () => {
    const engine = fakeEngine();
    const onInspect = vi.fn();
    const onFrame = vi.fn();
    renderInspect(engine, geoSpec({ title: 'Latency map' }), {
      data: geoData(),
      surface: 'geo',
      onInspect,
      onFrame,
    });
    const f = await frameOf(engine);
    expect(onFrame).toHaveBeenLastCalledWith(f);
    const host = document.querySelector<HTMLElement>('[data-chart-frame]');
    expect(host).toHaveAttribute('role', 'application');
    expect(host).toHaveAttribute('aria-roledescription', 'map');
    expect(host).toHaveAttribute('aria-label', 'Latency map');
    expect(host?.tabIndex).toBe(0);
    expect(f.init.keyTarget).toBe(host);
    expect(f.canvas).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole('slider')).toBeNull();
    act(() => {
      f.emit('select', {
        source: 'pointer',
        item: { kind: 'geo', id: 'cluster:k03', keys: ['k01', 'k02', 'k03', 'k04', 'k08'] },
      });
    });
    expect(onInspect).toHaveBeenCalledTimes(1);
    const [target, source, rf] = onInspect.mock.calls[0] as [InspectorTarget, string, unknown];
    expect(target.type).toBe('geo');
    if (target.type !== 'geo') return;
    expect(target.target).toMatchObject({ kind: 'cluster', id: 'cluster:k03' });
    expect(target.target.rows.map((r) => r.key)).toEqual(['k01', 'k02', 'k03', 'k04', 'k08']);
    expect(selectionOf(target)).toEqual({
      keys: ['k01', 'k02', 'k03', 'k04', 'k08'],
      fromMs: null,
      toMs: null,
    });
    expect(source).toBe('pointer');
    expect(rf).toBe(host);
    act(() => {
      f.emit('hover', {
        source: 'pointer',
        tMs: null,
        xCss: 976,
        yCss: 242,
        rows: [],
        item: { kind: 'geo', id: 'k05', keys: ['k05'] },
      });
    });
    const tip = document.querySelector<HTMLElement>('[data-chart-tooltip]');
    expect(tip?.hidden).toBe(false);
    expect(
      [...(tip?.querySelectorAll('[data-tooltip-line]') ?? [])].map((x) => x.textContent),
    ).toEqual(['{geo_country_iso_code="jp"}', '60 ms · ok', 'Japan']);
    act(() => {
      f.emit('hover', {
        source: 'pointer',
        tMs: null,
        xCss: 389,
        yCss: 154,
        rows: [],
        item: { kind: 'geo', id: 'cluster:k03', keys: ['k01', 'k02', 'k03', 'k04', 'k08'] },
      });
    });
    expect(
      [...(tip?.querySelectorAll('[data-tooltip-line]') ?? [])].map((x) => x.textContent),
    ).toEqual([
      'Cluster of 5',
      'worst degraded',
      '{cloud_provider="gcp", cloud_region="europe-west1"}, {cloud_region="westeurope"}, {cloud_region="eu-west-1"}, {cloud_region="eu-west-2"}, {geohash="u4pruydqqvj"}',
    ]);
    act(() => {
      f.emit('hover', null);
    });
    expect(tip?.hidden).toBe(true);
  });
});
