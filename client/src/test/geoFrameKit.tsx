/**
 * The geomap host's test kit (plan #234 Part 3 §5, Part 4 §5): `GeoMapFrame` on a board panel over
 * the real Inspector host and a fake engine, recording every inspected target, and the scene's marks
 * for a frame.
 */
import { act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { expect } from 'vitest';
import GeoMapFrame, { type GeoMapFrameHostProps } from '../charts/GeoMapFrame';
import type { ChartEngine, GeoMapSpec, GeoMarksEvent, GeoView } from '../engine/api';
import { ChartEngineContext } from '../engine/index';
import type { InspectorTarget } from '../inspector/types';
import { useChartInspect } from '../inspector/useChartInspect';
import { G, TH } from '../vis/geo/fixtures/series';
import type { GeoFrame } from '../vis/geo/frame';
import { fakeEngine, type FakeEngine, type FakeFrame } from './fakeEngine';
import { frameOf, sceneKit } from './geoKit';
import { MS } from './geoHostKit';
import { renderHost, type HostHarness } from './inspectorKit';

export const SIZE = { current: { width: 1024, height: 512 } };

/** The inspected targets, in order (the wrapper records each one). */
export const seen: InspectorTarget[] = [];

/** A board panel's inspect props over the real host, recording each target. */
export function Inspecting({ p }: { p: GeoMapFrameHostProps }) {
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

export interface Kit {
  readonly h: HostHarness;
  engine: ChartEngine;
  props: GeoMapFrameHostProps;
  set(p: Partial<GeoMapFrameHostProps>): void;
  swap(e: ChartEngine): void;
  frame(): FakeFrame;
  root(): HTMLElement;
  live(): string;
}

export function host(
  p: GeoMapFrameHostProps,
  engine: ChartEngine = fakeEngine(),
  extra?: ReactNode,
): Kit {
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

export const specOf = (f: FakeFrame): GeoMapSpec => f.last('setSpec')?.[0] as GeoMapSpec;

/** The scene's marks for `f` at fit (or `view`). */
export function marksOf(f: GeoFrame, view: GeoView | null = null): GeoMarksEvent {
  const k = sceneKit({ frame: f, spec: { view, motion: 'cut' } });
  const m = k.marks.at(-1);
  if (m === undefined) throw new Error('no geoMarks');
  return m;
}

export const G_TH = (): GeoFrame => frameOf(G(), { th: TH });

export function emitMarks(f: FakeFrame, m: GeoMarksEvent = marksOf(G_TH())): void {
  act(() => {
    f.emit('geoMarks', m);
  });
}

export const listButtons = (): HTMLButtonElement[] => [
  ...document.querySelectorAll<HTMLButtonElement>('[data-geo-list] button'),
];
