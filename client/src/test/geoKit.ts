/**
 * Shared setup of the geomap engine tests (plan #234 Part 2 §5): fixture frames, a geomap spec, a
 * `GeoController` on a fake stage with a fake clock and timers, and a live scene over recording
 * contexts. Every fixture is T24 §10.4's (gazetteer T, plot 1024 × 512).
 */
import { EMPTY_BASEMAP, type SeriesFrame } from '../data/frames';
import type {
  FrameEvents,
  GeoCommitEvent,
  GeoMapSpec,
  GeoMarksEvent,
  GeoView,
  HoverEvent,
  SelectEvent,
} from '../engine/api';
import { GeoController } from '../engine/controller/geo/controller';
import { camOf, toPx, type WorldPoint } from '../engine/controller/geo/camera';
import { drawOrder, levelMarks, radiiOf, type LaidMark } from '../engine/controller/geo/marks';
import { uOf, vOf } from '../engine/controller/geo/project';
import type { Emit } from '../engine/controller/stage';
import { createGeoScene, type GeoScene } from '../engine/canvas2d/geo/scene';
import type { Thresholds } from '../vis/thresholds';
import { COMPLETE, G, gazT, opts } from '../vis/geo/fixtures/series';
import { geoFrame, geoRowSet, type GeoFrame, type GeomapOptions } from '../vis/geo/frame';
import type { Basemap } from '../vis/geo/types';
import { recordingContext, type RecordingContext } from './recordingContext';

export const W = 1024;
export const H = 512;
const gaz = gazT();

/** A geomap frame of `series` (instant), gazetteer T, over `basemap` (empty by default). */
export function frameOf(
  series: readonly SeriesFrame[] = G(),
  o: { th?: Thresholds | null; opts?: Partial<GeomapOptions>; basemap?: Basemap; seq?: number } = {},
): GeoFrame {
  const s = geoRowSet(series, 'instant', opts(o.opts), o.th ?? null, gaz, COMPLETE);
  return geoFrame(s, o.basemap ?? EMPTY_BASEMAP, o.seq ?? 1);
}

export function geoSpec(over: Partial<GeoMapSpec> = {}): GeoMapSpec {
  return {
    kind: 'geomap',
    title: 'Map',
    unit: { kind: 'time', base: 'ms' },
    view: null,
    motion: 'ease',
    size: { by: 'value', min: 4, max: 20 },
    colour: 'group',
    symbol: 'circle',
    labels: 'auto',
    cluster: true,
    wheelZoom: true,
    ...over,
  };
}

/** The world position of a placed row. */
export function worldOf(f: GeoFrame, key: string): WorldPoint {
  const r = f.rows.find((x) => x.key === key);
  if (r?.location.status !== 'placed') throw new Error(`${key} is not placed`);
  return { u: uOf(r.location.place.lon), v: vOf(r.location.place.lat) };
}

/** CSS px of `key` under `view` on the 1024 × 512 plot. */
export function pxOf(f: GeoFrame, key: string, view: GeoView, w = W, h = H) {
  const p = worldOf(f, key);
  return toPx(camOf(view), p.u, p.v, w, h);
}

/** The shown rows' world positions. */
export function shownOf(f: GeoFrame): WorldPoint[] {
  return [...f.shown].map((i) => {
    const r = f.rows[i];
    if (r?.location.status !== 'placed') throw new Error('a shown row is not placed');
    return { u: uOf(r.location.place.lon), v: vOf(r.location.place.lat) };
  });
}

/** A fake clock with `setTimeout`-like timers that run on `advance`. */
export function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { due: number; cb: () => void }>();
  return {
    now: () => now,
    setTimer: (cb: () => void, ms: number): number => {
      seq += 1;
      timers.set(seq, { due: now + ms, cb });
      return seq;
    },
    clearTimer: (id: number): void => {
      timers.delete(id);
    },
    /** Moves the clock by `ms`, running the timers that fall due, in order. */
    advance(ms: number): void {
      const end = now + ms;
      for (;;) {
        let id: number | null = null;
        let due = Infinity;
        for (const [k, t] of timers) {
          if (t.due <= end && t.due < due) {
            id = k;
            due = t.due;
          }
        }
        const t = id === null ? undefined : timers.get(id);
        if (id === null || t === undefined) break;
        timers.delete(id);
        now = due;
        t.cb();
      }
      now = end;
    },
  };
}

export interface Seen {
  readonly commits: GeoCommitEvent[];
  readonly brushes: FrameEvents['geoBrush'][];
  readonly marks: GeoMarksEvent[];
  readonly selects: SelectEvent[];
  readonly hovers: (HoverEvent | null)[];
  emit: Emit;
}

export function seen(): Seen {
  const s = {
    commits: [] as GeoCommitEvent[],
    brushes: [] as FrameEvents['geoBrush'][],
    marks: [] as GeoMarksEvent[],
    selects: [] as SelectEvent[],
    hovers: [] as (HoverEvent | null)[],
  };
  const emit: Emit = (e, ev) => {
    if (e === 'geoCommit') s.commits.push(ev as GeoCommitEvent);
    else if (e === 'geoBrush') s.brushes.push(ev as FrameEvents['geoBrush']);
    else if (e === 'geoMarks') s.marks.push(ev as GeoMarksEvent);
    else if (e === 'select') s.selects.push(ev as SelectEvent);
    else if (e === 'hover') s.hovers.push(ev as HoverEvent | null);
  };
  return { ...s, emit };
}

export interface CtlKit extends Seen {
  readonly ctl: GeoController;
  readonly canvas: HTMLCanvasElement;
  readonly keyTarget: HTMLElement;
  readonly clock: ReturnType<typeof fakeClock>;
  frame: GeoFrame;
  spec: GeoMapSpec;
  /** `redraw` calls so far. */
  redraws(): number;
  /** Ticks every 16 ms for `ms` ms (the clock moves); the last tick's result. */
  run(ms: number): boolean;
  /** Replaces the data and tells the controller. */
  setData(f: GeoFrame): void;
  setSpec(over: Partial<GeoMapSpec>): void;
}

/** A `GeoController` on a 1024 × 512 plot over a stage of `frame`'s real marks. */
export function ctlKit(o: { frame?: GeoFrame; spec?: Partial<GeoMapSpec>; w?: number; h?: number } = {}): CtlKit {
  const clock = fakeClock();
  const s = seen();
  const canvas = document.createElement('canvas');
  const keyTarget = document.createElement('div');
  keyTarget.tabIndex = 0;
  document.body.append(keyTarget);
  let redraws = 0;
  const kit = {
    frame: o.frame ?? frameOf(),
    spec: geoSpec(o.spec),
  };
  let ctl: GeoController | null = null;
  const marks = (): readonly LaidMark[] => {
    if (ctl === null) return [];
    const r = radiiOf(kit.frame, kit.spec.size);
    return drawOrder(levelMarks(kit.frame, r, Math.floor(ctl.view.zoom), kit.spec.cluster));
  };
  ctl = new GeoController(
    canvas,
    keyTarget,
    {
      marks,
      shown: () => shownOf(kit.frame),
      redraw: () => {
        redraws += 1;
      },
    },
    {
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      wheelLatch: { lastPageWheel: () => -Infinity },
      emit: s.emit,
    },
  );
  const c = ctl;
  c.setSpec(kit.spec);
  c.resize(o.w ?? W, o.h ?? H);
  return Object.assign(kit, s, {
    ctl: c,
    canvas,
    keyTarget,
    clock,
    redraws: () => redraws,
    run(ms: number): boolean {
      let moving = c.tick(clock.now());
      for (let t = 0; t < ms; t += 16) {
        clock.advance(Math.min(16, ms - t));
        moving = c.tick(clock.now());
      }
      return moving;
    },
    setData(f: GeoFrame): void {
      kit.frame = f;
      c.dataChanged();
    },
    setSpec(over: Partial<GeoMapSpec>): void {
      kit.spec = { ...kit.spec, ...over };
      c.setSpec(kit.spec);
    },
  });
}

export interface SceneKit extends Seen {
  readonly scene: GeoScene;
  readonly canvas: HTMLCanvasElement;
  readonly keyTarget: HTMLElement;
  readonly clock: ReturnType<typeof fakeClock>;
  readonly ctx: RecordingContext;
  /** Draws once into `ctx` (cleared first); the summary. */
  draw(): ReturnType<GeoScene['draw']>;
  draws(): number;
}

/** A live scene of `frame` at 1024 × 512, DPR 1, dark, drawn once. */
export function sceneKit(o: { frame?: GeoFrame; spec?: Partial<GeoMapSpec> } = {}): SceneKit {
  const clock = fakeClock();
  const s = seen();
  const canvas = document.createElement('canvas');
  const keyTarget = document.createElement('div');
  document.body.append(keyTarget);
  const ctx = recordingContext();
  const scene = createGeoScene({
    canvas,
    keyTarget,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    wheelLatch: { lastPageWheel: () => -Infinity },
    emit: s.emit,
    requestDraw: () => undefined,
    createCanvas: () => document.createElement('canvas'),
    contextOf: () => recordingContext(),
  });
  scene.setSpec(geoSpec(o.spec));
  scene.setTheme('dark');
  scene.resize(W, H, 1);
  scene.setData(o.frame ?? frameOf());
  let draws = 0;
  const draw = () => {
    ctx.clearOps();
    draws += 1;
    return scene.draw(ctx);
  };
  draw();
  return { ...s, scene, canvas, keyTarget, clock, ctx, draw, draws: () => draws };
}
