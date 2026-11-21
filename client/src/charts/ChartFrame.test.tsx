import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';
import { StrictMode, useState, type ReactNode } from 'react';
import { createMemoryRouter, RouterProvider, type DataRouter } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';
import { StubApi } from '../api/StubApi';
import { Providers } from '../app/providers';
import type { RouterDeps } from '../app/router';
import type { FrameData, FrameSummary, HoverEvent, HoverRow, VisSpec } from '../engine/api';
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
  o: { strict?: boolean; fill?: boolean } = {},
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
    expect(engine.createCalls[0]?.init).toEqual({ timeZone: TZ, keyTarget: slider });
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
