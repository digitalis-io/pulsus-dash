import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';
import { StrictMode, useState, type ReactNode } from 'react';
import { createMemoryRouter, RouterProvider, type DataRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StubApi } from '../api/StubApi';
import { Providers } from '../app/providers';
import type { RouterDeps } from '../app/router';
import type {
  EventMarker,
  FrameData,
  FrameSummary,
  HoverEvent,
  HoverRow,
  VisSpec,
} from '../engine/api';
import { ChartEngineContext } from '../engine/index';
import { formatTime } from '../i18n/format';
import { createClock } from '../state/clock';
import { fakeEngine, type FakeEngine, type FakeFrame } from '../test/fakeEngine';
import { installResizeObserver, liveObservers, resizeAll } from '../test/fakeResizeObserver';
import { T } from '../test/renderApp';
import { ChartFrame } from './ChartFrame';
import styles from './ChartFrame.module.css';

const TZ = 'Europe/London';
const FROM = Date.UTC(2026, 10, 19, 12);
const TO = Date.UTC(2026, 10, 19, 13);
const URL0 = `/t/demo/x?from=2026-11-19T12:00:00.000Z&to=2026-11-19T13:00:00.000Z&refresh=off`;
const PLOT = { x: 50, y: 8, width: 900, height: 200 };
const K1 = '00000000000000a1';

const LINE: VisSpec = { kind: 'line', title: 'T', unit: { kind: 'time', base: 'ms' } };
const LINE7: VisSpec = { kind: 'line', title: 'T', unit: { kind: 'none' } };
const BARS30: VisSpec = {
  kind: 'bars',
  title: 'T',
  unit: { kind: 'none' },
  stacking: 'normal',
  categoryLabel: 'level',
  categoryOrder: [],
};
const DATA: FrameData = {
  kind: 'series',
  series: [
    { key: K1, labels: {}, timestamps: new Float64Array([FROM]), values: new Float64Array([1]) },
  ],
};

function renderFrame(
  engine: FakeEngine,
  spec: VisSpec,
  data: FrameData,
  o: {
    strict?: boolean;
    fill?: boolean;
    events?: readonly EventMarker[];
    stale?: readonly { fromMs: number; toMs: number }[];
  } = {},
): { router: DataRouter; unmount: () => void } {
  const deps: RouterDeps = {
    api: new StubApi(),
    queryClient: new QueryClient(),
    clock: createClock(() => T),
    timeZone: TZ,
  };
  const router = createMemoryRouter(
    [
      {
        path: '/t/:tenant/x',
        element: (
          <ChartEngineContext.Provider value={engine}>
            <ChartFrame
              spec={spec}
              data={data}
              {...(o.fill === undefined ? {} : { fill: o.fill })}
              {...(o.events === undefined ? {} : { events: o.events })}
              {...(o.stale === undefined ? {} : { stale: o.stale })}
            />
          </ChartEngineContext.Provider>
        ),
      },
    ],
    { initialEntries: [URL0] },
  );
  const tree: ReactNode = (
    <Providers deps={deps}>
      <RouterProvider router={router} />
    </Providers>
  );
  const view = render(o.strict === true ? <StrictMode>{tree}</StrictMode> : tree);
  return { router, unmount: view.unmount };
}

function lastFrame(engine: FakeEngine): FakeFrame {
  const f = engine.frames.at(-1);
  if (f === undefined) throw new Error('no frame');
  return f;
}

function summary(
  kind: FrameSummary['kind'],
  total: number,
  min: number,
  max: number,
  last: number,
): FrameSummary {
  return {
    kind,
    seriesTotal: total,
    seriesShown: total,
    fromMs: FROM,
    toMs: TO,
    min,
    max,
    last,
    plot: PLOT,
    valueAxis: kind === 'line' || kind === 'bars' ? { min, max, manual: false } : null,
    thresholdLabels: [],
    eventLabels: [],
    geo: null,
  };
}

const rows = (n: number, value = 7): HoverRow[] =>
  Array.from({ length: n }, (_, i) => ({
    key: `k${String(i)}`,
    name: `s${String(i + 1).padStart(2, '0')}`,
    colourIndex: i % 8,
    value,
  }));

const hover = (
  r: HoverRow[],
  yCss: number,
  source: HoverEvent['source'] = 'pointer',
): HoverEvent => ({
  source,
  tMs: FROM + 600_000,
  xCss: 200,
  yCss,
  rows: r,
});

function tooltip(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-chart-tooltip]');
  if (el === null) throw new Error('no tooltip');
  return el;
}
const shownNames = (): string[] =>
  [...tooltip().querySelectorAll('[data-name]')].map((e) => e.textContent);

beforeEach(() => {
  installResizeObserver();
});

describe('component lifecycle', () => {
  it('creates one canvas and one frame with the slider as key target', async () => {
    const engine = fakeEngine();
    const { unmount } = renderFrame(engine, LINE, DATA);
    await waitFor(() => {
      expect(engine.frames).toHaveLength(1);
    });
    const canvases = document.querySelectorAll('canvas[role=img]');
    expect(canvases).toHaveLength(1);
    const slider = screen.getByRole('slider', { name: 'Crosshair: T' });
    expect(engine.createCalls[0]?.init).toEqual({
      timeZone: TZ,
      keyTarget: slider,
      id: expect.stringMatching(/^f\d+$/) as unknown,
    });
    expect(engine.createCalls[0]?.canvas).toBe(canvases[0]);
    const f = lastFrame(engine);
    expect(f.last('setSpec')).toEqual([LINE]);
    expect(f.last('setData')).toEqual([DATA]);
    expect(f.last('setTimeWindow')).toEqual([{ fromMs: FROM, toMs: TO }]);
    expect(f.last('setTheme')).toEqual(['dark']);
    act(() => {
      resizeAll(640, 240);
    });
    expect(f.last('resize')).toEqual([640, 240, 1]);
    unmount();
    expect(f.disposed).toBe(1);
    expect(document.querySelectorAll('canvas')).toHaveLength(0);
    expect(liveObservers()).toBe(0);
  });

  it('under StrictMode keeps exactly one canvas and disposes the first frame once', async () => {
    const engine = fakeEngine();
    const { unmount } = renderFrame(engine, LINE, DATA, { strict: true });
    await waitFor(() => {
      expect(engine.frames.length).toBeGreaterThanOrEqual(2);
    });
    expect(document.querySelectorAll('canvas')).toHaveLength(1);
    expect(engine.frames[0]?.disposed).toBe(1);
    expect(lastFrame(engine).disposed).toBe(0);
    expect(lastFrame(engine).canvas.isConnected).toBe(true);
    unmount();
    expect(lastFrame(engine).disposed).toBe(1);
    expect(document.querySelectorAll('canvas')).toHaveLength(0);
  });
});

describe('component summary', () => {
  const HEAT: VisSpec = {
    kind: 'heatmap',
    title: 'T',
    unit: { kind: 'time', base: 's' },
    countUnit: { kind: 'none' },
  };
  const BARS: VisSpec = { ...BARS30, unit: { kind: 'suffix', suffix: 'lines' } };
  const STAT: VisSpec = { kind: 'stat', title: 'T', unit: { kind: 'time', base: 'ms' } };
  it.each<[VisSpec, FrameSummary, string]>([
    [
      LINE,
      summary('line', 50, 24, 336, 200),
      'T: line chart, 50 series, 12:00 – 13:00 GMT. Min 24 ms, max 336 ms, last 200 ms.',
    ],
    [
      BARS,
      summary('bars', 5, 3, 412, 260),
      'T: stacked bar chart, 5 series, 12:00 – 13:00 GMT. Min 3 lines, max 412 lines, last 260 lines.',
    ],
    [
      HEAT,
      summary('heatmap', 12, 0, 1000, 5210),
      'T: heatmap, 12 buckets, 12:00 – 13:00 GMT. Min 0, max 1k, last 5.21k.',
    ],
    [
      STAT,
      summary('stat', 1, 2843, 2843, 2843),
      'T: stat, 1 series, 12:00 – 13:00 GMT. Min 2.84 s, max 2.84 s, last 2.84 s.',
    ],
  ])('%o', async (spec, s, label) => {
    const engine = fakeEngine();
    const data: FrameData =
      spec.kind === 'stat' ? { kind: 'scalar', scalar: { value: 2843, timestampMs: TO } } : DATA;
    renderFrame(
      engine,
      spec,
      spec.kind === 'heatmap'
        ? {
            kind: 'heatmap',
            heatmap: {
              timestamps: new Float64Array([FROM]),
              bounds: new Float64Array([1]),
              counts: new Float64Array([1]),
            },
          }
        : data,
    );
    await waitFor(() => {
      expect(engine.frames).toHaveLength(1);
    });
    const host = document.querySelector('[data-chart-frame]');
    expect(host).toHaveAttribute('data-frame-ready', 'false');
    act(() => {
      lastFrame(engine).emit('a11y', s);
    });
    expect(document.querySelector('canvas')).toHaveAttribute('aria-label', label);
    expect(host).toHaveAttribute('data-frame-ready', 'true');
    expect(host).toHaveAttribute('data-plot', '50,8,900,200');
    expect(screen.queryAllByRole('slider')).toHaveLength(spec.kind === 'stat' ? 0 : 1);
  });

  it('shows the truncation notice', async () => {
    const engine = fakeEngine();
    renderFrame(engine, LINE, DATA);
    await waitFor(() => {
      expect(engine.frames).toHaveLength(1);
    });
    act(() => {
      lastFrame(engine).emit('a11y', { ...summary('line', 600, 1, 2, 3), seriesShown: 500 });
    });
    expect(screen.getByRole('status')).toHaveTextContent('Showing 500 of 600 series');
  });
});

describe('component summary label follows the spec', () => {
  it('updates the label when only the title or the unit changes', async () => {
    const engine = fakeEngine();
    let setSpec: (s: VisSpec) => void = () => undefined;
    function Switchable() {
      const [spec, set] = useState<VisSpec>(LINE);
      setSpec = set;
      return <ChartFrame spec={spec} data={DATA} />;
    }
    const deps: RouterDeps = {
      api: new StubApi(),
      queryClient: new QueryClient(),
      clock: createClock(() => T),
      timeZone: TZ,
    };
    const router = createMemoryRouter(
      [
        {
          path: '/t/:tenant/x',
          element: (
            <ChartEngineContext.Provider value={engine}>
              <Switchable />
            </ChartEngineContext.Provider>
          ),
        },
      ],
      { initialEntries: [URL0] },
    );
    render(
      <Providers deps={deps}>
        <RouterProvider router={router} />
      </Providers>,
    );
    await waitFor(() => {
      expect(engine.frames).toHaveLength(1);
    });
    act(() => {
      lastFrame(engine).emit('a11y', summary('line', 50, 24, 336, 200));
    });
    const canvas = (): Element | null => document.querySelector('canvas');
    expect(canvas()).toHaveAttribute(
      'aria-label',
      'T: line chart, 50 series, 12:00 – 13:00 GMT. Min 24 ms, max 336 ms, last 200 ms.',
    );
    act(() => {
      setSpec({ ...LINE, title: 'U' });
    });
    expect(canvas()).toHaveAttribute(
      'aria-label',
      'U: line chart, 50 series, 12:00 – 13:00 GMT. Min 24 ms, max 336 ms, last 200 ms.',
    );
    act(() => {
      setSpec({ kind: 'line', title: 'U', unit: { kind: 'time', base: 's' } });
    });
    expect(canvas()).toHaveAttribute(
      'aria-label',
      'U: line chart, 50 series, 12:00 – 13:00 GMT. Min 24 s, max 5.6 min, last 3.33 min.',
    );
    expect(engine.frames).toHaveLength(1);
  });
});

describe('component threshold labels (#64 Part B)', () => {
  it('clipped labels get focusable tooltips', async () => {
    const engine = fakeEngine();
    const spec: VisSpec = {
      ...LINE7,
      thresholds: [
        { value: 5, state: 'failing', label: 'A long objective label' },
        { value: 3, state: 'watch', label: 'Warn' },
      ],
    };
    renderFrame(engine, spec, DATA);
    await waitFor(() => {
      expect(engine.frames).toHaveLength(1);
    });
    const full = '■ A long objective label';
    act(() => {
      lastFrame(engine).emit('a11y', {
        ...summary('line', 1, 1, 1, 1),
        thresholdLabels: [
          { box: { x: 66, y: 20, width: 120, height: 15 }, text: full, clipped: true },
          { box: { x: 66, y: 60, width: 49, height: 15 }, text: '◐ Warn', clipped: false },
        ],
      });
    });
    const hits = document.querySelectorAll<HTMLElement>('[data-threshold-hit]');
    expect(hits).toHaveLength(1);
    const hit = hits[0];
    expect(hit, 'no hit target').not.toBeUndefined();
    if (hit === undefined) throw new Error('no hit target');
    expect(hit).toHaveAttribute('aria-label', full);
    expect(hit).toHaveAttribute('tabindex', '0');
    expect(parseFloat(hit.style.width)).toBeGreaterThanOrEqual(24);
    expect(parseFloat(hit.style.height)).toBeGreaterThanOrEqual(24);
    // Grown about the box's centre (T08-010): the 15 px tall box becomes 24 px.
    expect(parseFloat(hit.style.top)).toBeCloseTo(20 + 7.5 - 12, 6);
    expect(parseFloat(hit.style.left)).toBeCloseTo(66, 6);
    const user = userEvent.setup();
    await user.tab();
    await user.tab();
    expect(hit).toHaveFocus();
    expect(await screen.findByRole('tooltip')).toHaveTextContent(full);
  });
});

describe('component event markers (#64 Part C)', () => {
  it('event hit targets', async () => {
    const engine = fakeEngine();
    const at = (h: number, m: number): number => Date.UTC(2026, 0, 1, h, m);
    const events: EventMarker[] = [
      { id: 'd', atMs: at(0, 30), endMs: null, kind: 'deploy', title: 'v2.31' },
      { id: 'c', atMs: at(0, 45), endMs: null, kind: 'config', title: 'flags' },
      { id: 'n', atMs: at(0, 46), endMs: at(1, 10), kind: 'annotation', title: 'm' },
    ];
    renderFrame(engine, LINE7, DATA, { events });
    await waitFor(() => {
      expect(engine.frames).toHaveLength(1);
    });
    expect(lastFrame(engine).last('setEvents')?.[0]).toBe(events);
    act(() => {
      lastFrame(engine).emit('a11y', {
        ...summary('line', 1, 1, 1, 1),
        eventLabels: [
          {
            box: { x: 100, y: 8, width: 49, height: 14 },
            x: 104.5,
            ids: ['d'],
            text: '◆ v2.31',
            clipped: false,
          },
          {
            box: { x: 300, y: 8, width: 14, height: 14 },
            x: 304.5,
            ids: ['c', 'n'],
            text: '⚙ flags; m',
            clipped: true,
          },
        ],
      });
    });
    const hits = [...document.querySelectorAll<HTMLElement>('[data-event-hit]')];
    expect(hits.map((h) => h.getAttribute('aria-label'))).toEqual([
      'Deploy · v2.31 · 00:30:00',
      'Config change · flags · 00:45:00; Note · m · 00:46:00–01:10:00',
    ]);
    expect(hits.map((h) => h.dataset['eventX'])).toEqual(['104.5', '304.5']);
    for (const h of hits) {
      expect(h).toHaveAttribute('tabindex', '0');
      expect(parseFloat(h.style.width)).toBeGreaterThanOrEqual(24);
      expect(parseFloat(h.style.height)).toBeGreaterThanOrEqual(24);
    }
    const label = document.querySelector('canvas')?.getAttribute('aria-label') ?? '';
    expect(label.endsWith('Events in view: 3.')).toBe(true);
    const second = hits[1];
    if (second === undefined) throw new Error('no second hit');
    const user = userEvent.setup();
    for (let i = 0; i < 5 && document.activeElement !== second; i++) await user.tab();
    expect(second).toHaveFocus();
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Config change · flags · 00:45:00; Note · m · 00:46:00–01:10:00',
    );
  });
});

describe('component brush', () => {
  it('a drag pushes the absolute window; a double-click zooms out', async () => {
    const engine = fakeEngine();
    const { router } = renderFrame(engine, LINE, DATA);
    await waitFor(() => {
      expect(engine.frames).toHaveLength(1);
    });
    const search = (): Record<string, string> =>
      Object.fromEntries(new URLSearchParams(router.state.location.search));
    act(() => {
      lastFrame(engine).emit('brush', {
        fromMs: FROM + 20 * 60_000,
        toMs: FROM + 25 * 60_000,
        gesture: 'drag',
      });
    });
    await waitFor(() => {
      expect(search()).toMatchObject({
        from: '2026-11-19T12:20:00.000Z',
        to: '2026-11-19T12:25:00.000Z',
      });
    });
    expect(router.state.historyAction).toBe('PUSH');
    act(() => {
      lastFrame(engine).emit('brush', { fromMs: 0, toMs: 0, gesture: 'zoomOut' });
    });
    await waitFor(() => {
      expect(search()).toMatchObject({
        from: '2026-11-19T12:17:30.000Z',
        to: '2026-11-19T12:27:30.000Z',
      });
    });
    expect(engine.frames).toHaveLength(1);
  });
});

describe('component hover', () => {
  async function ready(spec: VisSpec): Promise<FakeFrame> {
    const engine = fakeEngine();
    renderFrame(engine, spec, DATA);
    await waitFor(() => {
      expect(engine.frames).toHaveLength(1);
    });
    const f = lastFrame(engine);
    act(() => {
      f.emit('a11y', summary(spec.kind, 30, 7, 7, 7));
    });
    return f;
  }

  it('Escape at an active crosshair stays in the chart', async () => {
    const f = await ready(LINE7);
    const outer: string[] = [];
    const listen = (e: KeyboardEvent): void => {
      outer.push(e.key);
    };
    document.addEventListener('keydown', listen);
    const slider = screen.getByRole('slider');
    act(() => {
      f.emit('hover', hover(rows(1), 8, 'keyboard'));
    });
    fireEvent.keyDown(slider, { key: 'Escape' });
    expect(outer).toEqual([]);
    act(() => {
      f.emit('hover', null);
    });
    fireEvent.keyDown(slider, { key: 'Escape' });
    expect(outer).toEqual(['Escape']);
    document.removeEventListener('keydown', listen);
  });

  it.each([LINE7, BARS30])('the pointer row window reaches all 30 rows (%o)', async (spec) => {
    const f = await ready(spec);
    const all = rows(30);
    act(() => {
      f.emit('hover', hover(all, 8));
    });
    expect(tooltip()).not.toHaveAttribute('hidden');
    expect(shownNames()).toEqual(all.slice(0, 20).map((r) => r.name));
    expect(tooltip().querySelector('[data-range]')).toHaveTextContent('Rows 1–20 of 30');
    act(() => {
      f.emit('hover', hover(all, 208));
    });
    expect(shownNames()).toEqual(all.slice(10).map((r) => r.name));
    expect(tooltip().querySelector('[data-range]')).toHaveTextContent('Rows 11–30 of 30');
    const seen = new Set<string>();
    for (let y = 8; y <= 208; y++) {
      act(() => {
        f.emit('hover', hover(all, y));
      });
      for (const n of shownNames()) seen.add(n);
    }
    expect(seen.size).toBe(30);
  });

  it('the keyboard selects every row and reads it out', async () => {
    const user = userEvent.setup();
    const f = await ready(LINE7);
    const slider = screen.getByRole('slider', { name: 'Crosshair: T' });
    expect(slider).toHaveAttribute('aria-valuetext', 'Use the arrow keys to read values');
    act(() => {
      f.emit('hover', hover(rows(30), 8, 'keyboard'));
    });
    slider.focus();
    const selected = new Set<string>();
    const sel = (): string =>
      tooltip().querySelector('[data-selected] [data-name]')?.textContent ?? '';
    selected.add(sel());
    for (let i = 0; i < 29; i++) {
      await user.keyboard('{ArrowDown}');
      selected.add(sel());
    }
    expect(selected.size).toBe(30);
    const time = formatTime(FROM + 600_000, TZ);
    expect(slider).toHaveAttribute('aria-valuetext', `${time}: s30 7, 30 of 30`);
    expect(slider).toHaveAttribute('aria-valuenow', String(FROM + 600_000));
    act(() => {
      f.emit('hover', null);
    });
    expect(tooltip()).toHaveAttribute('hidden');
    expect(slider).toHaveAttribute('aria-valuetext', 'Use the arrow keys to read values');
    act(() => {
      f.emit('hover', hover(rows(3), 8));
    });
    expect(tooltip().querySelectorAll('[data-row]')).toHaveLength(3);
    expect(tooltip().querySelector('[data-range]')).toBeNull();
  });
});

describe('component invalid / unsupported', () => {
  it('sends empty data and explains an invalid frame', async () => {
    const engine = fakeEngine();
    const bad: FrameData = {
      kind: 'series',
      series: [
        {
          key: K1,
          labels: {},
          timestamps: new Float64Array([1, 2, 3]),
          values: new Float64Array([1, 2]),
        },
      ],
    };
    renderFrame(engine, LINE, bad);
    await waitFor(() => {
      expect(engine.frames).toHaveLength(1);
    });
    expect(lastFrame(engine).last('setData')).toEqual([{ kind: 'series', series: [] }]);
    expect(
      screen.getByText(
        `This chart cannot show its data: series ${K1} has 3 timestamps and 2 values`,
      ),
    ).toBeInTheDocument();
  });

  it('explains a browser without a 2D context', async () => {
    const engine = fakeEngine({ unsupported: true });
    renderFrame(engine, LINE, DATA);
    expect(await screen.findByText('This browser cannot draw charts.')).toBeInTheDocument();
    expect(document.querySelectorAll('canvas')).toHaveLength(0);
  });
});

describe('component theme', () => {
  it('follows data-theme', async () => {
    const engine = fakeEngine();
    renderFrame(engine, LINE, DATA);
    await waitFor(() => {
      expect(engine.frames).toHaveLength(1);
    });
    document.documentElement.dataset['theme'] = 'light';
    await waitFor(() => {
      expect(lastFrame(engine).last('setTheme')).toEqual(['light']);
    });
  });
});

describe('component fill', () => {
  it('fill', () => {
    const engine = fakeEngine();
    const filled = renderFrame(engine, LINE, DATA, { fill: true });
    const root = (): HTMLElement => {
      const el = document.querySelector<HTMLElement>('[data-chart-frame]');
      if (el === null) throw new Error('no frame');
      return el;
    };
    expect(root()).toHaveClass(styles['fill'] ?? 'fill');
    expect(root()).not.toHaveClass(styles['chart'] ?? 'chart');
    filled.unmount();
    renderFrame(engine, LINE, DATA);
    expect(root()).toHaveClass(styles['chart'] ?? 'chart');
    expect(root()).not.toHaveClass(styles['fill'] ?? 'fill');
  });
});

describe('component pre-size and pending (#90)', () => {
  const STAT: VisSpec = { kind: 'stat', title: 'T', unit: { kind: 'none' } };
  const BARS: VisSpec = BARS30;
  const LOADING = <p>Loading</p>;

  /** A `ChartFrame` whose spec the test switches; `fill` and `pending` as given. */
  function renderSwitchable(
    engine: FakeEngine,
    o: {
      fill?: boolean;
      pending?: ReactNode;
      sizeMemo?: { current: { width: number; height: number } | null };
    } = {},
  ): { setSpec: (s: VisSpec) => void } {
    const out: { setSpec: (s: VisSpec) => void } = { setSpec: () => undefined };
    function Switchable() {
      const [spec, set] = useState<VisSpec>(LINE);
      out.setSpec = set;
      return (
        <ChartFrame
          spec={spec}
          data={DATA}
          {...(o.fill === undefined ? {} : { fill: o.fill })}
          {...(o.pending === undefined ? {} : { pending: o.pending })}
          {...(o.sizeMemo === undefined ? {} : { sizeMemo: o.sizeMemo })}
        />
      );
    }
    const deps: RouterDeps = {
      api: new StubApi(),
      queryClient: new QueryClient(),
      clock: createClock(() => T),
      timeZone: TZ,
    };
    const router = createMemoryRouter(
      [
        {
          path: '/t/:tenant/x',
          element: (
            <ChartEngineContext.Provider value={engine}>
              <Switchable />
            </ChartEngineContext.Provider>
          ),
        },
      ],
      { initialEntries: [URL0] },
    );
    act(() => {
      render(
        <Providers deps={deps}>
          <RouterProvider router={router} />
        </Providers>,
      );
    });
    return out;
  }

  const resizes = (f: FakeFrame) => f.calls.filter((c) => c.method === 'resize').map((c) => c.args);
  const pendingEl = (): Element | null => document.querySelector('[data-chart-pending]');
  const host = (): HTMLElement => {
    const el = document.querySelector<HTMLElement>('[data-chart-frame]');
    if (el === null) throw new Error('no frame');
    return el;
  };
  const switchTo = (o: { setSpec: (s: VisSpec) => void }, s: VisSpec): void => {
    act(() => {
      o.setSpec(s);
    });
  };
  const draw = (engine: FakeEngine): void => {
    act(() => {
      lastFrame(engine).draw();
    });
  };
  const resize = (w: number, h: number): void => {
    act(() => {
      resizeAll(w, h);
    });
  };

  it('a re-created fill frame is sized at once', () => {
    const engine = fakeEngine();
    const o = renderSwitchable(engine, { fill: true, pending: LOADING });
    resize(640, 240);
    for (const [spec, n] of [
      [STAT, 2],
      [LINE, 3],
    ] as const) {
      switchTo(o, spec);
      expect(engine.frames).toHaveLength(n);
      expect(engine.frames[n - 2]?.disposed).toBe(1);
      const f = lastFrame(engine);
      expect(resizes(f)).toEqual([[640, 240, 1]]);
      const methods = f.calls.map((c) => c.method);
      expect(methods.indexOf('resize')).toBeGreaterThan(methods.indexOf('setSpec'));
    }
  });

  it('an equal observed size is not re-applied', () => {
    const engine = fakeEngine();
    const o = renderSwitchable(engine, { fill: true, pending: LOADING });
    resize(640, 240);
    switchTo(o, STAT);
    expect(resizes(lastFrame(engine))).toEqual([[640, 240, 1]]);
    resize(640, 240);
    expect(resizes(lastFrame(engine))).toHaveLength(1);
    resize(320, 240);
    expect(resizes(lastFrame(engine))).toEqual([
      [640, 240, 1],
      [320, 240, 1],
    ]);
  });

  it('pending until drawn at the current size', () => {
    const engine = fakeEngine();
    renderSwitchable(engine, { fill: true, pending: LOADING });
    expect(pendingEl()).toHaveTextContent('Loading');
    expect(resizes(lastFrame(engine))).toEqual([]);
    resize(640, 240);
    expect(pendingEl()).not.toBeNull();
    act(() => {
      lastFrame(engine).emit('drawn', { cssWidth: 320, cssHeight: 240, dpr: 1 });
    });
    expect(pendingEl()).not.toBeNull();
    draw(engine);
    expect(pendingEl()).toBeNull();
    resize(320, 240);
    expect(pendingEl()).not.toBeNull();
    draw(engine);
    expect(pendingEl()).toBeNull();
    resize(0, 0);
    expect(pendingEl()).not.toBeNull();
    draw(engine);
    expect(pendingEl()).not.toBeNull();
  });

  it('pending on frame replacement and kind change', () => {
    const engine = fakeEngine();
    const o = renderSwitchable(engine, { fill: true, pending: LOADING });
    resize(640, 240);
    draw(engine);
    expect(pendingEl()).toBeNull();
    for (const [spec, frames] of [
      [STAT, 2],
      [LINE, 3],
      [BARS, 3],
    ] as const) {
      switchTo(o, spec);
      expect(engine.frames, spec.kind).toHaveLength(frames);
      expect(pendingEl(), spec.kind).not.toBeNull();
      if (spec !== BARS) expect(resizes(lastFrame(engine))).toEqual([[640, 240, 1]]);
      draw(engine);
      expect(pendingEl(), spec.kind).toBeNull();
    }
  });

  it('a size memo pre-sizes a new mount', () => {
    const engine = fakeEngine();
    const memo = {
      current: { width: 640, height: 240 } as { width: number; height: number } | null,
    };
    renderSwitchable(engine, { fill: true, pending: LOADING, sizeMemo: memo });
    expect(resizes(lastFrame(engine))).toEqual([[640, 240, 1]]);
    expect(pendingEl()).not.toBeNull();
    draw(engine);
    expect(pendingEl()).toBeNull();
    resize(500, 200);
    expect(memo.current).toEqual({ width: 500, height: 200 });
    resize(0, 0);
    expect(memo.current).toEqual({ width: 500, height: 200 });
  });

  it('frame id', () => {
    const engine = fakeEngine();
    const o = renderSwitchable(engine, { fill: true, pending: LOADING });
    const first = lastFrame(engine).init.id;
    expect(first).toEqual(expect.any(String));
    expect(host().dataset['frameId']).toBe(first);
    switchTo(o, STAT);
    const second = lastFrame(engine).init.id;
    expect(second).toEqual(expect.any(String));
    expect(host().dataset['frameId']).toBe(second);
    expect(second).not.toBe(first);
  });

  it('a non-fill frame is not pre-sized', () => {
    const engine = fakeEngine();
    const o = renderSwitchable(engine);
    resize(640, 240);
    switchTo(o, STAT);
    expect(engine.frames).toHaveLength(2);
    expect(resizes(lastFrame(engine))).toEqual([]);
    resize(640, 120);
    expect(resizes(lastFrame(engine))).toEqual([[640, 120, 1]]);
  });

  it('unsupported: no progress', async () => {
    const engine = fakeEngine({ unsupported: true });
    renderSwitchable(engine, { fill: true, pending: LOADING });
    expect(await screen.findByText('This browser cannot draw charts.')).toBeInTheDocument();
    expect(pendingEl()).toBeNull();
  });
});

describe('component camera commit (#93)', () => {
  /** A `ChartFrame` whose spec a test can change, inside the router (URL0). */
  function switchable(engine: FakeEngine, first: VisSpec) {
    let setSpec: (s: VisSpec) => void = () => undefined;
    function Switchable() {
      const [spec, set] = useState<VisSpec>(first);
      setSpec = set;
      return <ChartFrame spec={spec} data={DATA} />;
    }
    const deps: RouterDeps = {
      api: new StubApi(),
      queryClient: new QueryClient(),
      clock: createClock(() => T),
      timeZone: TZ,
    };
    const router = createMemoryRouter(
      [
        {
          path: '/t/:tenant/x',
          element: (
            <ChartEngineContext.Provider value={engine}>
              <Switchable />
            </ChartEngineContext.Provider>
          ),
        },
      ],
      { initialEntries: [URL0] },
    );
    render(
      <Providers deps={deps}>
        <RouterProvider router={router} />
      </Providers>,
    );
    return {
      router,
      setSpec: (s: VisSpec) => {
        act(() => {
          setSpec(s);
        });
      },
    };
  }

  async function ready(spec: VisSpec = LINE) {
    const engine = fakeEngine();
    const r = switchable(engine, spec);
    await waitFor(() => {
      expect(engine.frames).toHaveLength(1);
    });
    const f = lastFrame(engine);
    act(() => {
      f.emit('a11y', summary(spec.kind, 1, 24, 336, 200));
    });
    return { ...r, engine, f };
  }

  const lastSpec = (f: FakeFrame): VisSpec => f.last('setSpec')?.[0] as VisSpec;
  const resetButton = () => screen.queryByRole('button', { name: 'Reset Y axis: T' });
  const pin = (f: FakeFrame, min = 1, max = 2): void => {
    act(() => {
      f.emit('commit', { window: null, value: { min, max }, gesture: 'wheel' });
    });
  };

  it('commit sets the window (push)', async () => {
    const { router, f } = await ready();
    act(() => {
      f.emit('commit', {
        window: { fromMs: FROM + 20 * 60_000, toMs: FROM + 25 * 60_000 },
        value: null,
        gesture: 'wheel',
      });
    });
    await waitFor(() => {
      expect(Object.fromEntries(new URLSearchParams(router.state.location.search))).toMatchObject({
        from: '2026-11-19T12:20:00.000Z',
        to: '2026-11-19T12:25:00.000Z',
      });
    });
    expect(router.state.historyAction).toBe('PUSH');
  });

  it('commit pins the value axis', async () => {
    const { router, f } = await ready();
    const before = router.state.location.search;
    pin(f);
    expect(lastSpec(f)).toMatchObject({ valueRange: { min: 1, max: 2 } });
    expect(resetButton()).toBeInTheDocument();
    expect(resetButton()).toHaveTextContent('Reset Y axis');
    expect(router.state.location.search).toBe(before);
  });

  it('reset returns to auto', async () => {
    const user = userEvent.setup();
    const { f } = await ready();
    pin(f);
    const b = resetButton();
    expect(b).toBeInTheDocument();
    if (b === null) return;
    act(() => {
      b.focus();
    });
    await user.keyboard('{Enter}');
    expect(lastSpec(f)).not.toHaveProperty('valueRange');
    expect(resetButton()).toBeNull();
    expect(screen.getByRole('slider')).toHaveFocus();
  });

  it("'auto' commit clears the pin", async () => {
    const { f } = await ready();
    pin(f);
    expect(resetButton()).toBeInTheDocument();
    act(() => {
      f.emit('commit', { window: null, value: 'auto', gesture: 'fit' });
    });
    expect(lastSpec(f)).not.toHaveProperty('valueRange');
    expect(resetButton()).toBeNull();
  });

  it('pin dropped on kind or unit change', async () => {
    for (const next of [BARS30, { ...LINE, unit: { kind: 'time', base: 's' } } as VisSpec]) {
      const { f, setSpec } = await ready();
      pin(f);
      expect(resetButton()).toBeInTheDocument();
      setSpec(next);
      expect(lastSpec(f)).not.toHaveProperty('valueRange');
      expect(resetButton()).toBeNull();
      cleanup();
    }
  });

  it.each<[string, VisSpec]>([
    ['line → bars → line', { ...BARS30, unit: { kind: 'time', base: 'ms' } }],
    ['unit round trip', { ...LINE, unit: { kind: 'time', base: 's' } }],
  ])('pin does not return: %s', async (_name, middle) => {
    const { f, setSpec } = await ready();
    pin(f);
    expect(lastSpec(f)).toMatchObject({ valueRange: { min: 1, max: 2 } });
    setSpec(middle);
    setSpec(LINE);
    expect(lastSpec(f)).not.toHaveProperty('valueRange');
    expect(resetButton()).toBeNull();
    act(() => {
      f.emit('a11y', summary('line', 1, 24, 336, 200));
    });
    expect(document.querySelector('canvas')?.getAttribute('aria-label')).not.toContain(
      'Y axis fixed at',
    );
  });

  it('pinned summary label', async () => {
    const { f } = await ready();
    act(() => {
      f.emit('a11y', {
        ...summary('line', 50, 24, 336, 200),
        valueAxis: { min: 1, max: 2, manual: true },
      });
    });
    expect(document.querySelector('canvas')?.getAttribute('aria-label')).toMatch(
      /Min 24 ms, max 336 ms, last 200 ms\. Y axis fixed at 1 ms to 2 ms\.$/,
    );
  });
});

describe('stale spans and reduced motion (#304 §4.3, Part B §4.5)', () => {
  it('stale overlay', async () => {
    const engine = fakeEngine();
    renderFrame(engine, LINE, DATA, { stale: [{ fromMs: TO - 600_000, toMs: TO + 3_600_000 }] });
    await waitFor(() => {
      expect(engine.frames).toHaveLength(1);
    });
    expect(document.querySelectorAll('[data-stale-span]')).toHaveLength(0);
    act(() => {
      lastFrame(engine).emit('a11y', {
        ...summary('line', 1, 1, 2, 3),
        plot: { x: 100, y: 8, width: 600, height: 200 },
      });
    });
    const spans = document.querySelectorAll<HTMLElement>('[data-stale-span]');
    expect(spans).toHaveLength(1);
    expect(spans[0]?.style.left).toBe('600px');
    expect(spans[0]?.style.width).toBe('100px');
    expect(spans[0]?.style.top).toBe('8px');
    expect(spans[0]?.style.height).toBe('200px');
  });

  it('reduced motion', async () => {
    vi.stubGlobal(
      'matchMedia',
      (q: string) =>
        ({
          matches: q.includes('prefers-reduced-motion: reduce'),
          media: q,
          onchange: null,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
          dispatchEvent: () => false,
        }) as unknown as MediaQueryList,
    );
    try {
      const engine = fakeEngine();
      renderFrame(engine, LINE, { ...DATA, transition: 'crossfade' });
      await waitFor(() => {
        expect(engine.frames).toHaveLength(1);
      });
      const d = lastFrame(engine).last('setData')?.[0] as FrameData | undefined;
      expect(d?.kind).toBe('series');
      expect(d !== undefined && 'transition' in d ? d.transition : undefined).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
