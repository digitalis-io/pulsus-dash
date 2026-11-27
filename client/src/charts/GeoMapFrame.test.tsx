/**
 * The geomap host (T24-088, T24-092 to T24-095, T25 §4.9; plan #234 Part 3 §4.1–§4.5, §4.4a,
 * §4.9, §4.10): `unit:geo-host` (the view hand-off and the subscriptions), `unit:geo-targets` (host
 * rows), `unit:geo-single-group`, `unit:geo-states`, `unit:geo-render-failed` (c), (d) and
 * `unit:geo-preview-members` (a), (b), on a fake engine (or the real Canvas 2D engine) under the
 * real Inspector host.
 */
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/types';
import type { PanelRun } from '../boards/usePanelRun';
import {
  Canvas2DEngine,
  geoModuleLoader,
  loadGeoModule,
  type GeoModule,
} from '../engine/canvas2d/Canvas2DEngine';
import type { SeriesFrame } from '../data/frames';
import type { ChartEngine, GeoMapSpec, GeoMarksEvent, GeoView } from '../engine/api';
import { ChartEngineContext } from '../engine/index';
import type { InspectorTarget } from '../inspector/types';
import { useChartInspect } from '../inspector/useChartInspect';
import { geoMapChunk, GeoMapBody } from '../pages/board/GeoMapBody';
import { fakeEngine, type FakeEngine, type FakeFrame } from '../test/fakeEngine';
import { installResizeObserver } from '../test/fakeResizeObserver';
import { frameOf, sceneKit } from '../test/geoKit';
import { GEO_DATA, hostProps, MS, runOf } from '../test/geoHostKit';
import { renderHost, stubReducedMotion, type HostHarness } from '../test/inspectorKit';
import { recordingContext } from '../test/recordingContext';
import { G, M12, O2, S1, TH } from '../vis/geo/fixtures/series';
import type { GeoFrame, GeoRowSet } from '../vis/geo/frame';
import GeoMapFrame, { type GeoMapFrameHostProps } from './GeoMapFrame';

/** `(d)` of `unit:geo-states`: k12 marked `ok`, a set `validateGeoRows` refuses (`value`). */
const hook = vi.hoisted(() => ({ k12ok: false }));
vi.mock('../vis/geo/frame', async (importOriginal) => {
  const m = await importOriginal<typeof import('../vis/geo/frame')>();
  return {
    ...m,
    geoRowSet: (...a: Parameters<typeof m.geoRowSet>): GeoRowSet => {
      const s = m.geoRowSet(...a);
      if (!hook.k12ok) return s;
      return {
        ...s,
        rows: s.rows.map((r) => (r.key === 'k12' ? { ...r, valueStatus: 'ok' as const } : r)),
      };
    },
  };
});

let restoreMotion: () => void = () => undefined;
beforeEach(() => {
  installResizeObserver();
  restoreMotion = stubReducedMotion(true);
});
afterEach(() => {
  cleanup();
  restoreMotion();
  vi.useRealTimers();
  vi.restoreAllMocks();
  hook.k12ok = false;
});

const SIZE = { current: { width: 1024, height: 512 } };
const C: GeoView = { lat: 50, lon: 5, zoom: 4 };
const D: GeoView = { lat: 40, lon: -70, zoom: 5 };
const E: GeoView = { lat: 1, lon: 103, zoom: 6 };
const V10: GeoView = { lat: 10, lon: 10, zoom: 4 };
const BOUNDS = { west: -10, south: -10, east: 10, north: 10 };

/** The inspected targets, in order (the wrapper records each one). */
const seen: InspectorTarget[] = [];

/** A board panel's inspect props over the real host, recording each target. */
function Inspecting({ p }: { p: GeoMapFrameHostProps }) {
  const inspect = useChartInspect({
    surface: 'board',
    panelId: p.panelId,
    title: p.title,
    query: { lang: 'promql', text: 'up' },
    unit: MS,
  });
  const base = inspect.onInspect;
  return (
    <GeoMapFrame
      {...p}
      {...(base === undefined
        ? {}
        : {
            onInspect: (t, s, rf) => {
              seen.push(t);
              base(t, s, rf);
            },
          })}
    />
  );
}

interface Kit {
  readonly h: HostHarness;
  engine: ChartEngine;
  props: GeoMapFrameHostProps;
  set(p: Partial<GeoMapFrameHostProps>): void;
  swap(e: ChartEngine): void;
  frame(): FakeFrame;
  root(): HTMLElement;
  live(): string;
}

function host(p: GeoMapFrameHostProps, engine: ChartEngine = fakeEngine(), extra?: ReactNode): Kit {
  seen.length = 0;
  const node = (k: { engine: ChartEngine; props: GeoMapFrameHostProps }): ReactNode => (
    <ChartEngineContext.Provider value={k.engine}>
      <button type="button" data-outside="">
        outside
      </button>
      <div data-panel-id={k.props.panelId}>
        <Inspecting p={k.props} />
      </div>
      {extra}
    </ChartEngineContext.Provider>
  );
  const state = { engine, props: { sizeMemo: SIZE, fill: true, ...p } };
  const h = renderHost(node(state));
  return {
    h,
    get engine() {
      return state.engine;
    },
    get props() {
      return state.props;
    },
    set(q) {
      state.props = { ...state.props, ...q };
      h.rerender(node(state));
    },
    swap(e) {
      state.engine = e;
      h.rerender(node(state));
    },
    frame() {
      const f = (state.engine as FakeEngine).frames.at(-1);
      expect(f, 'an engine frame').toBeDefined();
      if (f === undefined) throw new Error('no frame');
      return f;
    },
    root() {
      const r = document.querySelector<HTMLElement>('[data-geomap]');
      expect(r, 'the geomap root').not.toBeNull();
      if (r === null) throw new Error('no geomap root');
      return r;
    },
    live() {
      return document.querySelector('[data-geo-live]')?.textContent ?? '';
    },
  };
}

const specOf = (f: FakeFrame): GeoMapSpec => f.last('setSpec')?.[0] as GeoMapSpec;

/** The scene's marks for `f` at fit (or `view`). */
function marksOf(f: GeoFrame, view: GeoView | null = null): GeoMarksEvent {
  const k = sceneKit({ frame: f, spec: { view, motion: 'cut' } });
  const m = k.marks.at(-1);
  if (m === undefined) throw new Error('no geoMarks');
  return m;
}

const G_TH = (): GeoFrame => frameOf(G(), { th: TH });

function emitMarks(f: FakeFrame, m: GeoMarksEvent = marksOf(G_TH())): void {
  act(() => {
    f.emit('geoMarks', m);
  });
}

const listButtons = (): HTMLButtonElement[] => [
  ...document.querySelectorAll<HTMLButtonElement>('[data-geo-list] button'),
];

describe('unit:geo-host', () => {
  it('three subscriptions; the view hand-off (a)–(e); an engine swap (f)', () => {
    const k = host(hostProps());
    const f1 = k.frame();
    expect(['geoCommit', 'geoBrush', 'geoMarks'].map((e) => f1.listening(e as never))).toEqual([
      1, 1, 1,
    ]);
    expect(specOf(f1).view).toBeNull();
    act(() => {
      f1.emit('geoCommit', { view: C, bounds: BOUNDS, gesture: 'pan' });
    });
    expect(specOf(f1).view).toEqual(C);
    k.set({ options: { ...k.props.options, view: V10 } });
    expect(specOf(f1).view).toEqual(V10);
    act(() => {
      f1.emit('geoCommit', { view: D, bounds: BOUNDS, gesture: 'wheel' });
    });
    expect(specOf(f1).view).toEqual(D);
    k.set({ options: { ...k.props.options, view: null } });
    expect(specOf(f1).view).toBeNull();
    act(() => {
      f1.emit('geoCommit', { view: E, bounds: BOUNDS, gesture: 'keys' });
    });
    k.set({ title: 'New title' });
    expect(specOf(f1)).toMatchObject({ view: E, title: 'New title' });
    emitMarks(f1);
    act(() => {
      listButtons()[2]?.focus();
    });
    expect(f1.last('setFocusMark')).toEqual(['k05']);
    const e2 = fakeEngine();
    k.swap(e2);
    expect(f1.offs).toEqual(expect.arrayContaining(['geoCommit', 'geoBrush', 'geoMarks']));
    expect(f1.disposed).toBe(1);
    const f2 = k.frame();
    expect(f2).not.toBe(f1);
    expect(specOf(f2).view).toEqual(E);
    expect(f2.calls.some((c) => c.method === 'setFocusMark' && c.args[0] === 'k05')).toBe(true);
    // An old frame's event changes nothing.
    act(() => {
      f1.emit('geoCommit', { view: C, bounds: BOUNDS, gesture: 'pan' });
    });
    expect(specOf(f2).view).toEqual(E);
    k.set({ options: { ...k.props.options, view: V10 } });
    k.swap(fakeEngine());
    expect(specOf(k.frame()).view).toEqual(V10);
  });
});

describe('unit:geo-targets (host rows)', () => {
  it('G: k05 and cluster:k03 inspect; the brush; an empty click; the select block; the toggle', async () => {
    const k = host(hostProps());
    const f = k.frame();
    emitMarks(f);
    act(() => {
      f.emit('select', { source: 'pointer', item: { kind: 'geo', id: 'k05', keys: ['k05'] } });
    });
    expect(seen.at(-1)).toMatchObject({ type: 'geo', target: { kind: 'marker', members: null } });
    expect(k.h.selection()).toBe('k05|null|null');
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      '{geo_country_iso_code="jp"}',
    );
    const c3 = ['k01', 'k02', 'k03', 'k04', 'k08'];
    act(() => {
      f.emit('select', { source: 'pointer', item: { kind: 'geo', id: 'cluster:k03', keys: c3 } });
    });
    expect(seen.at(-1)).toMatchObject({
      type: 'geo',
      target: { kind: 'cluster', id: 'cluster:k03' },
    });
    expect(k.h.selection()).toBe(`${c3.join(',')}|null|null`);
    act(() => {
      f.emit('geoBrush', { keys: c3.slice(0, 2) });
    });
    expect(k.h.selection()).toBe('k01,k02|null|null');
    act(() => {
      f.emit('geoBrush', { keys: [] });
    });
    expect(k.h.selection()).toBe('k01,k02|null|null');
    act(() => {
      f.emit('select', { source: 'pointer', item: null });
    });
    expect(k.h.selection()).toBe('null');
    act(() => {
      k.h
        .api()
        .select({ keys: ['k10'], fromMs: null, toMs: null }, { kind: 'mark', panelId: 'p1' });
    });
    expect(f.last('setSelection')).toEqual([{ keys: ['k10'], fromMs: null, toMs: null }]);
    fireEvent.keyDown(k.root(), { key: 'T', shiftKey: true });
    const row = document.querySelector<HTMLElement>('[data-row-key="k10"]');
    expect(row).toHaveTextContent('Not placed');
    const user = userEvent.setup();
    act(() => {
      k.h.api().select(null, { kind: 'mark', panelId: 'p1' });
    });
    const toggle = screen.getByRole('button', { name: 'Select {lat="91", lon="0"}' });
    await user.click(toggle);
    expect(k.h.selection()).toBe('k10|null|null');
    await user.click(screen.getByRole('button', { name: 'Select {lat="91", lon="0"}' }));
    expect(k.h.selection()).toBe('null');
    const k10 = document.querySelector<HTMLElement>('[data-row-key="k10"]');
    if (k10 === null) throw new Error('no k10 row');
    await user.click(k10.querySelector('[data-row-inspect]') as HTMLElement);
    expect(seen.at(-1)).toMatchObject({ type: 'geo', target: { kind: 'marker', id: 'k10' } });
  });

  it('O2: the legend other (3) → its keys and the aggregate with three entries; e8 selects only', async () => {
    const k = host(hostProps(O2(), { options: { groupBy: 'env' }, thresholds: null }));
    emitMarks(k.frame(), marksOf(frameOf(O2(), { opts: { groupBy: 'env' } })));
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^other \(3\)/ }));
    expect(k.h.selection()).toBe('q07,q08,q09,q10|null|null');
    const t = seen.at(-1);
    expect(t?.type).toBe('geo');
    if (t?.type !== 'geo') return;
    expect(t.target.kind).toBe('aggregate');
    expect(t.target.members?.map((m) => [m.text, m.labels, m.keys])).toEqual([
      ['"other (2)"', { env: 'other (2)' }, ['q07']],
      ['e8', { env: 'e8' }, ['q08', 'q10']],
      ['e9', { env: 'e9' }, ['q09']],
    ]);
    const n = seen.length;
    await user.click(screen.getByRole('button', { name: /^e1\b/ }));
    expect(k.h.selection()).toBe('q01|null|null');
    expect(seen).toHaveLength(n);
  });
});

describe('unit:geo-single-group', () => {
  it('S1: no legend; Tab surface → list → meter; a marker click selects', async () => {
    const k = host(hostProps(S1(), { options: { groupBy: 'env' } }));
    emitMarks(k.frame(), marksOf(frameOf(S1(), { th: TH, opts: { groupBy: 'env' } })));
    expect(document.querySelector('[data-geo-legend]')).toBeNull();
    const user = userEvent.setup();
    act(() => {
      (document.querySelector('[data-outside]') as HTMLElement).focus();
    });
    await user.tab();
    expect(document.activeElement).toBe(document.querySelector('[data-chart-frame]'));
    await user.tab();
    expect(document.activeElement).toBe(listButtons()[0]);
    await user.tab();
    expect(document.activeElement?.closest('[data-geo-meter]')).not.toBeNull();
    act(() => {
      k.frame().emit('select', {
        source: 'pointer',
        item: { kind: 'geo', id: 's2', keys: ['s2'] },
      });
    });
    expect(k.h.selection()).toBe('s2|null|null');
  });
});

describe('unit:geo-states', () => {
  /** `ok` G with thresholds: focus on item 2, the selection [k03], cluster:k03 open. */
  function okG(extra?: ReactNode): Kit {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(Date.UTC(2026, 10, 19, 12, 30));
    const k = host(hostProps(), fakeEngine(), extra);
    emitMarks(k.frame());
    act(() => {
      k.frame().emit('select', {
        source: 'pointer',
        item: { kind: 'geo', id: 'cluster:k03', keys: ['k01', 'k02', 'k03', 'k04', 'k08'] },
      });
    });
    act(() => {
      k.h
        .api()
        .select({ keys: ['k03'], fromMs: null, toMs: null }, { kind: 'mark', panelId: 'p1' });
    });
    act(() => {
      listButtons()[1]?.focus();
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    return k;
  }
  const kept = (k: Kit): void => {
    expect(k.h.selection()).toBe('k03|null|null');
    expect(k.h.aside()).not.toBeNull();
  };
  const status = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-geo-status]');
  const run = (o: Partial<PanelRun>, series: SeriesFrame[] | null = G()): PanelRun =>
    runOf(series, o);

  it('(a) a new window answered at 100 ms: the busy status, then item 1, no announcement', () => {
    const k = okG();
    k.set({ run: run({ placeholder: true, fetching: true }) });
    expect(status()).toHaveAttribute('aria-busy', 'true');
    expect(document.activeElement).toBe(status());
    expect(status()?.textContent).toBe('');
    act(() => {
      vi.advanceTimersByTime(100);
    });
    k.set({ run: run({}) });
    emitMarks(k.frame());
    expect(document.activeElement).toBe(listButtons()[0]);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(k.live()).toBe('');
    kept(k);
  });

  it('(b) answered at 400 ms: "Loading…" at 300 ms, then item 1 and "5 marks"', () => {
    const k = okG();
    k.set({ run: run({ placeholder: true, fetching: true }) });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(status()).toHaveTextContent('Loading…');
    act(() => {
      vi.advanceTimersByTime(100);
    });
    k.set({ run: run({}) });
    emitMarks(k.frame());
    expect(document.activeElement).toBe(listButtons()[0]);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(k.live()).toBe('5 marks');
    kept(k);
  });

  it('(c) HTTP 500: Retry focused, "Couldn\'t load data"; Retry runs again', () => {
    const k = okG();
    const retry = vi.fn();
    k.set({ run: runOf(null, { error: new ApiError('unavailable', '500'), retry }) });
    const b = screen.getByRole('button', { name: 'Retry' });
    expect(document.activeElement).toBe(b);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(k.live()).toBe("Couldn't load data");
    fireEvent.click(b);
    expect(retry).toHaveBeenCalledTimes(1);
    kept(k);
  });

  it('(d) k12 ok: the status "Invalid map data (value)" focused and announced', () => {
    const k = okG();
    hook.k12ok = true;
    k.set({ run: run({}) });
    expect(status()).toHaveTextContent('Invalid map data (value)');
    expect(document.activeElement).toBe(status());
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(k.live()).toBe('Invalid map data (value)');
    kept(k);
  });

  it('(e) the basemap 404: Show table focused, the parts on the meter', () => {
    const k = okG();
    k.set({ geoData: { basemap: null, gazetteer: GEO_DATA.gazetteer } });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Show table' }));
    expect(status()).toHaveTextContent('Map data unavailable');
    expect(document.querySelector('[data-geo-meter]')).toHaveTextContent(
      '3 not placed · 1 ambiguous · 1 outside the map · 4 without a usable value (2 missing, 1 infinite, 1 out of range) · 1 duplicate series combined; 1 conflicts (max kept)',
    );
    kept(k);
  });

  it('(f) 100 × 100: too small, Show table → 18 rows; 0 rows → the header only', () => {
    const k = okG();
    k.set({ sizeMemo: { current: { width: 100, height: 100 } } });
    expect(status()).toHaveTextContent('Too small to show a map: 18 series');
    fireEvent.click(screen.getByRole('button', { name: 'Show table' }));
    expect(document.querySelectorAll('[data-row-key]')).toHaveLength(18);
    expect(document.activeElement).toBe(
      screen.getByRole('button', {
        name: 'Select {cloud_provider="gcp", cloud_region="europe-west1"}',
      }),
    );
    k.set({ run: run({}, []) });
    expect(document.querySelectorAll('[data-row-key]')).toHaveLength(0);
    expect(document.querySelector('[role=columnheader]')).not.toBeNull();
    kept(k);
  });

  it('(g) 0 series: the <p> "No series in this window" focused, meter 100 %', () => {
    const k = okG();
    k.set({ run: run({}, []) });
    const p = status();
    expect(p?.tagName).toBe('P');
    expect(p).toHaveTextContent('No series in this window');
    expect(document.activeElement).toBe(p);
    expect(document.querySelector('[data-geo-meter]')).toHaveTextContent('100 %');
    kept(k);
  });

  it('(h) only k09–k11, k15: the <p> with the parts', () => {
    const k = okG();
    k.set({
      run: run(
        {},
        G().filter((s) => ['k09', 'k10', 'k11', 'k15'].includes(s.key)),
      ),
    });
    expect(status()?.tagName).toBe('P');
    expect(status()).toHaveTextContent(
      'No series could be placed: 3 not placed · 1 ambiguous · 1 without a usable value (1 missing)',
    );
    expect(document.activeElement).toBe(status());
    kept(k);
  });

  it('(i) a refetch failing at 12:31:05: the list kept, the meter stale, "Couldn\'t refresh"', () => {
    const k = okG();
    vi.setSystemTime(Date.UTC(2026, 10, 19, 12, 31, 5));
    const outcome = k.props.run.outcome;
    k.set({ run: { ...k.props.run, outcome, error: new ApiError('unavailable', '500') } });
    expect(listButtons()).toHaveLength(5);
    expect(document.querySelector('[data-geo-meter]')?.textContent).toMatch(
      / · stale \(12:31:05\)$/,
    );
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(k.live()).toBe("Couldn't refresh");
    kept(k);
  });

  it('(j) (c) with focus in the board header: no focus move, no announcement', () => {
    const k = okG();
    const header = document.querySelector<HTMLElement>('[data-outside]');
    act(() => {
      header?.focus();
    });
    k.set({ run: runOf(null, { error: new ApiError('unavailable', '500') }) });
    expect(document.activeElement).toBe(header);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(k.live()).toBe('');
    kept(k);
  });

  it('(k) (c) with focus in the Inspector: focus stays there', () => {
    const k = okG();
    const close = k.h.aside()?.querySelector<HTMLElement>('button');
    act(() => {
      close?.focus();
    });
    k.set({ run: runOf(null, { error: new ApiError('unavailable', '500') }) });
    expect(document.activeElement).toBe(close);
    kept(k);
  });
});

/** A Canvas 2D engine over recording contexts, its frames run by `flush`. */
function realEngine(loadGeo: () => Promise<GeoModule>) {
  const queue = new Map<number, () => void>();
  let next = 0;
  const engine = new Canvas2DEngine({
    requestFrame: (cb) => {
      next += 1;
      queue.set(next, cb);
      return next;
    },
    cancelFrame: (id) => {
      queue.delete(id);
    },
    contextOf: () => recordingContext(),
    createCanvas: () => document.createElement('canvas'),
    fonts: null,
    now: () => 0,
    setTimer: () => 0,
    clearTimer: () => undefined,
    wheelLatch: { lastPageWheel: () => -Infinity },
    loadGeo,
  });
  const flush = (): void => {
    for (let i = 0; i < 5; i++) {
      const cbs = [...queue.values()];
      queue.clear();
      for (const cb of cbs) cb();
    }
  };
  return { engine, flush };
}

async function settleAll(flush: () => void): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    });
    act(flush);
  }
}

describe('unit:geo-render-failed (the consumer, §4.4a, §4.10)', () => {
  function body(engine: ChartEngine): HostHarness {
    return renderHost(
      <ChartEngineContext.Provider value={engine}>
        <div data-panel-id="p1">
          <GeoMapBody {...hostProps()} geoData={GEO_DATA} sizeMemo={SIZE} fill />
        </div>
      </ChartEngineContext.Provider>,
    );
  }

  it('(c) the first scene import rejects: "Map couldn\'t load" + Retry; Retry draws the map', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const mod = await loadGeoModule();
    const imp = vi
      .fn<() => Promise<GeoModule>>()
      .mockImplementationOnce(() => Promise.reject(new Error('chunk failed')))
      .mockImplementation(() => Promise.resolve(mod));
    const { engine, flush } = realEngine(geoModuleLoader(imp));
    const h = body(engine);
    await settleAll(flush);
    act(() => {
      h.api().select({ keys: ['k03'], fromMs: null, toMs: null }, { kind: 'mark', panelId: 'p1' });
    });
    expect(await screen.findByText("Map couldn't load")).not.toBeNull();
    const retry = screen.getByRole('button', { name: 'Retry' });
    fireEvent.click(retry);
    await settleAll(flush);
    expect(imp).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Map couldn't load")).toBeNull();
    expect(document.querySelector('[data-chart-frame]')).toHaveAttribute(
      'data-frame-ready',
      'true',
    );
    expect(listButtons().length).toBeGreaterThan(0);
    expect(h.selection()).toBe('k03|null|null');
  });

  it('(d) both scene imports reject: after Retry the Reload text and button', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const reload = vi.spyOn(geoMapChunk, 'reload').mockImplementation(() => undefined);
    const imp = vi
      .fn<() => Promise<GeoModule>>()
      .mockImplementation(() => Promise.reject(new Error('chunk failed')));
    const { engine, flush } = realEngine(geoModuleLoader(imp));
    body(engine);
    await settleAll(flush);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await settleAll(flush);
    expect(imp).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Map couldn't load. Reload the page to try again.")).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('unit:geo-preview-members (a), (b)', () => {
  const M = (): GeoMapFrameHostProps => ({
    ...hostProps(M12(), { thresholds: null }),
    sizeMemo: SIZE,
    fill: true,
  });
  const m12keys = M12().map((s) => s.key);

  function openCluster(f: FakeFrame): void {
    act(() => {
      f.emit('select', {
        source: 'pointer',
        item: { kind: 'geo', id: 'cluster:m12', keys: m12keys },
      });
    });
  }

  function moreGives12(): void {
    fireEvent.click(screen.getByRole('button', { name: '+4 more' }));
    const items = document.querySelectorAll('[data-section="members"] li');
    expect(items).toHaveLength(12);
    expect(items[11]?.textContent).toBe('{lat="10", lon="10", pod="p12"}');
  }

  it('(a) a full screen of the panel opens and closes: "+4 more" resolves to 12', () => {
    const engine = fakeEngine();
    const k = host(M(), engine);
    const board = k.frame();
    openCluster(board);
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Cluster of 12');
    const full = <GeoMapFrame {...M()} key="full" />;
    k.h.rerender(
      <ChartEngineContext.Provider value={engine}>
        <div data-panel-id="p1">
          <Inspecting p={k.props} />
        </div>
        {full}
      </ChartEngineContext.Provider>,
    );
    k.h.rerender(
      <ChartEngineContext.Provider value={engine}>
        <div data-panel-id="p1">
          <Inspecting p={k.props} />
        </div>
      </ChartEngineContext.Provider>,
    );
    moreGives12();
    expect(k.h.selection()).toBe(`${m12keys.join(',')}|null|null`);
  });

  it('(b) an editor preview never registers, inspects or selects; the open target is unchanged', () => {
    const engine = fakeEngine();
    const k = host(M(), engine);
    openCluster(k.frame());
    const sel = k.h.selection();
    const withPreview = (on: boolean) => (
      <ChartEngineContext.Provider value={engine}>
        <div data-panel-id="p1">
          <Inspecting p={k.props} />
        </div>
        {on && <GeoMapFrame {...M()} inspectorSource={false} key="preview" />}
      </ChartEngineContext.Provider>
    );
    const register = vi.spyOn(k.h.api(), 'registerMembers');
    k.h.rerender(withPreview(true));
    const preview = engine.frames.at(-1) as FakeFrame;
    act(() => {
      preview.emit('select', {
        source: 'pointer',
        item: { kind: 'geo', id: 'm01', keys: ['m01'] },
      });
      preview.emit('geoBrush', { keys: ['m02'] });
      preview.emit('select', { source: 'pointer', item: null });
    });
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Cluster of 12');
    expect(k.h.selection()).toBe(sel);
    k.h.rerender(withPreview(false));
    expect(register).not.toHaveBeenCalled();
    moreGives12();
    expect(k.h.selection()).toBe(sel);
  });
});
