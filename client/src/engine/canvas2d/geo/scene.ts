/**
 * The geomap scene of the Canvas 2D engine (ADR-0027, ADR-0031; plan #234 Part 2 §3.1, §4.6, §4.7):
 * the dynamic entry `Canvas2DFrame` imports on its first `geomap` spec, so nothing geo is in the
 * board route's static closure. It owns the renderer-free `GeoController` (camera, input, inertia)
 * and paints through `basemap.ts` and `paint.ts`: the basemap, the marks of the level Z = ⌊zoom⌋
 * (radii and clusters cached per level, data, size, cluster option and group count), the 150 ms
 * crossfade between levels (none under `motion: 'cut'`), labels, the selection and focus rings and
 * the box or brush band. It emits `hover`, `select`, `geoCommit`, `geoBrush` and `geoMarks`, and
 * returns the frame summary of each draw.
 *
 * `geoMarks` (ADR-0027 (4)) goes out unconditionally right after each `geoCommit` (one per commit,
 * drawn or not), and on the first draw, on new data and on a level change; after any other draw only when its payload (level, then each mark's
 * id, kind, keys and in-view flag, in keyboard order) differs from the last one sent.
 */
import { EMPTY_BASEMAP } from '../../../data/frames';
import type { GeoFrame } from '../../../vis/geo/frame';
import type {
  CameraKey,
  FrameSelection,
  FrameSummary,
  GeoMapSpec,
  GeoMarksEvent,
  ThemeName,
} from '../../api';
import { boundsOf, type WorldPoint } from '../../controller/geo/camera';
import { GeoController } from '../../controller/geo/controller';
import {
  drawOrder,
  keyboardOrder,
  levelMarks,
  placeLabels,
  radiiOf,
  type LaidMark,
} from '../../controller/geo/marks';
import { placeInto } from '../../controller/geo/pick';
import { uOf, vOf } from '../../controller/geo/project';
import type { Emit } from '../../controller/stage';
import type { Ctx2D } from '../ctx';
import type { WheelLatch } from '../input';
import { themeColours } from '../palette';
import { drawBasemap } from './basemap';
import { LABEL_FONT, paintBand, paintLabels, paintMarks, type MarkPaint } from './paint';
import { patternTiles, type PatternTiles } from './patterns';

export interface GeoSceneDeps {
  canvas: HTMLCanvasElement;
  keyTarget: HTMLElement | null;
  now(): number;
  setTimer(cb: () => void, ms: number): number;
  clearTimer(id: number): void;
  wheelLatch: WheelLatch;
  /** hover, select, geoCommit, geoBrush, geoMarks. */
  emit: Emit;
  requestDraw(): void;
  createCanvas(): HTMLCanvasElement;
  contextOf(c: HTMLCanvasElement): Ctx2D | null;
}

export interface GeoScene {
  setSpec(s: GeoMapSpec): void;
  setData(f: GeoFrame): void;
  setSelection(s: FrameSelection | null): void;
  setTheme(t: ThemeName): void;
  resize(w: number, h: number, dpr: number): void;
  setFocusMark(id: string | null): void;
  cameraKey(k: CameraKey): void;
  /** Paints into `ctx`; the summary (copied view: the committed one). */
  draw(ctx: Ctx2D): FrameSummary;
  animating(): boolean;
  dispose(): void;
}

/** A level change fades the old marks out and the new in over this many ms. */
export const CROSSFADE_MS = 150;
const LABEL_LINE = 14;

/** One level's marks, cached under its key; `x`, `y` are refilled each frame (no allocation). */
interface Level {
  readonly z: number;
  readonly frame: GeoFrame;
  readonly by: string;
  readonly min: number;
  readonly max: number;
  readonly cluster: boolean;
  readonly groups: number;
  /** Seed order (labels). */
  readonly seeded: readonly LaidMark[];
  /** Draw order (painting, pick). */
  readonly marks: readonly LaidMark[];
  readonly x: Float64Array;
  readonly y: Float64Array;
  /** Draw indices in keyboard order. */
  readonly keyboard: Int32Array;
  /** Draw index of each mark (labels). */
  readonly index: ReadonlyMap<LaidMark, number>;
  readonly clusters: number;
}

interface Stats {
  readonly min: number | null;
  readonly max: number | null;
  readonly last: number | null;
}

export function createGeoScene(d: GeoSceneDeps): GeoScene {
  return new Scene(d);
}

class Scene implements GeoScene {
  private spec: GeoMapSpec | null = null;
  private frame: GeoFrame | null = null;
  private selection: FrameSelection | null = null;
  private selected: {
    frame: GeoFrame;
    sel: FrameSelection;
    keys: ReadonlySet<string> | null;
  } | null = null;
  private theme: ThemeName = 'dark';
  private w = 0;
  private h = 0;
  private dpr = 1;
  private shown: WorldPoint[] = [];
  private stats: Stats = { min: null, max: null, last: null };
  private radii: { frame: GeoFrame; key: string; r: Float64Array } | null = null;
  private level: Level | null = null;
  /** The level drawn last (a level change crossfades from it). */
  private lastDrawn: Level | null = null;
  private fade: { from: Level; start: number } | null = null;
  private moving = false;
  /** The next draw sends `geoMarks` whatever its payload (first draw, new data). */
  private forceMarks = true;
  private lastMarks: GeoMarksEvent | null = null;
  private disposed = false;
  private readonly ctl: GeoController;
  private readonly tiles: PatternTiles;

  constructor(private readonly d: GeoSceneDeps) {
    this.tiles = patternTiles(
      () => d.createCanvas(),
      (c) => d.contextOf(c),
    );
    const emit: Emit = (e, ev) => {
      if (this.disposed) return;
      d.emit(e, ev);
      // Each commit is followed by its own `geoMarks`, at once (ADR-0027 (4)).
      if (e === 'geoCommit') this.marksAfterCommit();
    };
    this.ctl = new GeoController(
      d.canvas,
      d.keyTarget,
      {
        marks: () => this.currentLevel()?.marks ?? [],
        shown: () => this.shown,
        rowWorld: (row) => {
          const r = this.frame?.rows[row];
          return r?.location.status === 'placed'
            ? { u: uOf(r.location.place.lon), v: vOf(r.location.place.lat) }
            : null;
        },
        redraw: () => {
          if (!this.disposed) d.requestDraw();
        },
      },
      {
        now: () => d.now(),
        setTimer: (cb, ms) => d.setTimer(cb, ms),
        clearTimer: (id) => {
          d.clearTimer(id);
        },
        wheelLatch: d.wheelLatch,
        emit,
      },
    );
  }

  setSpec(s: GeoMapSpec): void {
    if (this.disposed) return;
    this.spec = s;
    this.ctl.setSpec(s);
    this.d.requestDraw();
  }

  setData(f: GeoFrame): void {
    if (this.disposed) return;
    this.frame = f;
    const shown: WorldPoint[] = [];
    let min = Infinity;
    let max = -Infinity;
    let last: number | null = null;
    for (const i of f.shown) {
      const r = f.rows[i];
      if (r?.location.status !== 'placed') continue;
      shown.push({ u: uOf(r.location.place.lon), v: vOf(r.location.place.lat) });
      min = Math.min(min, r.value);
      max = Math.max(max, r.value);
      last = r.value;
    }
    this.shown = shown;
    this.stats = last === null ? { min: null, max: null, last: null } : { min, max, last };
    this.forceMarks = true;
    this.ctl.dataChanged();
    this.d.requestDraw();
  }

  setSelection(s: FrameSelection | null): void {
    if (this.disposed) return;
    this.selection = s;
    this.d.requestDraw();
  }

  setTheme(t: ThemeName): void {
    if (this.disposed) return;
    this.theme = t;
    this.d.requestDraw();
  }

  resize(w: number, h: number, dpr: number): void {
    if (this.disposed) return;
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.ctl.resize(w, h);
    this.d.requestDraw();
  }

  setFocusMark(id: string | null): void {
    if (!this.disposed) this.ctl.setFocusMark(id);
  }

  cameraKey(k: CameraKey): void {
    if (!this.disposed) this.ctl.cameraKey(k);
  }

  animating(): boolean {
    return !this.disposed && (this.moving || this.fade !== null);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.ctl.dispose();
    this.level = null;
    this.lastDrawn = null;
    this.fade = null;
    this.radii = null;
    this.frame = null;
  }

  draw(ctx: Ctx2D): FrameSummary {
    const now = this.d.now();
    this.moving = this.ctl.tick(now);
    const { w, h, dpr } = this;
    const c = themeColours(this.theme);
    const cam = this.ctl.camera;
    const f = this.frame;
    const spec = this.spec;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawBasemap(ctx, f?.basemap ?? EMPTY_BASEMAP, cam, w, h, {
      background: c.background,
      water: c.map.water,
      land: c.map.land,
      coast: c.map.coast,
      border: c.map.border,
    });
    const lv = this.currentLevel();
    if (f === null || spec === null || lv === null) return this.summary(null);
    const prev = this.lastDrawn;
    const levelChanged = prev !== null && prev.z !== lv.z;
    if (spec.motion === 'cut') this.fade = null;
    else if (levelChanged) this.fade = { from: prev, start: now };
    placeInto(lv.marks, cam, w, h, lv.x, lv.y);
    const style: MarkPaint = {
      frame: f,
      spec,
      colours: c,
      pattern: (name) => this.tiles.get(ctx, name, c.patternInk, dpr),
      selected: this.selectedKeys(f),
      focusId: this.ctl.focusMark,
    };
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.clip();
    let alpha = 1;
    const fade = this.fade;
    if (fade !== null) {
      const k = (now - fade.start) / CROSSFADE_MS;
      if (k >= 1) {
        this.fade = null;
      } else {
        const old = fade.from;
        placeInto(old.marks, cam, w, h, old.x, old.y);
        paintMarks(ctx, old, 1 - k, { ...style, frame: old.frame, focusId: null });
        alpha = Math.max(0, k);
      }
    }
    paintMarks(ctx, lv, alpha, style);
    if (spec.labels === 'auto') this.paintNames(ctx, lv, f, alpha);
    const box = this.ctl.box;
    if (box !== null) paintBand(ctx, box, c);
    ctx.restore();
    // A level change is forced unless a commit already sent this level's marks.
    this.emitMarks(lv, prev === null || (levelChanged && this.lastMarks?.level !== lv.z));
    this.lastDrawn = lv;
    return this.summary(lv);
  }

  private paintNames(ctx: Ctx2D, lv: Level, f: GeoFrame, alpha: number): void {
    ctx.font = LABEL_FONT;
    const labels = placeLabels(
      lv.seeded,
      (m) => f.rows[m.seed]?.name ?? '',
      (m) => {
        const i = lv.index.get(m) ?? 0;
        return { x: lv.x[i] ?? NaN, y: lv.y[i] ?? NaN };
      },
      (s) => ctx.measureText(s).width,
      this.w,
      this.h,
      LABEL_LINE,
    );
    ctx.globalAlpha = alpha;
    paintLabels(ctx, labels, themeColours(this.theme));
    ctx.globalAlpha = 1;
  }

  /** The level of the camera's ⌊zoom⌋, rebuilt when its key changes. */
  private currentLevel(): Level | null {
    const f = this.frame;
    const spec = this.spec;
    if (f === null || spec === null || this.disposed) return null;
    const z = Math.floor(this.ctl.camera.z);
    const s = spec.size;
    const l = this.level;
    if (
      l?.z === z &&
      l.frame === f &&
      l.by === s.by &&
      l.min === s.min &&
      l.max === s.max &&
      l.cluster === spec.cluster &&
      l.groups === f.groups.length
    ) {
      return l;
    }
    const key = `${s.by}|${String(s.min)}|${String(s.max)}|${String(f.groups.length)}`;
    if (this.radii?.frame !== f || this.radii.key !== key) {
      this.radii = { frame: f, key, r: radiiOf(f, s) };
    }
    const seeded = levelMarks(f, this.radii.r, z, spec.cluster);
    const marks = drawOrder(seeded);
    const x = new Float64Array(marks.length);
    const y = new Float64Array(marks.length);
    placeInto(marks, this.ctl.camera, this.w, this.h, x, y);
    const index = new Map(marks.map((m, i) => [m, i]));
    // The keyboard order is invariant under the per-frame scale and offset: computed once here.
    const keyboard = Int32Array.from(keyboardOrder({ marks, x, y }).map((m) => index.get(m) ?? 0));
    const next: Level = {
      z,
      frame: f,
      by: s.by,
      min: s.min,
      max: s.max,
      cluster: spec.cluster,
      groups: f.groups.length,
      seeded,
      marks,
      x,
      y,
      keyboard,
      index,
      clusters: marks.filter((m) => m.kind === 'cluster').length,
    };
    this.level = next;
    return next;
  }

  /** The marks as of the committed camera: sent unconditionally after a `geoCommit`. */
  private marksAfterCommit(): void {
    const lv = this.currentLevel();
    if (lv === null) return;
    placeInto(lv.marks, this.ctl.camera, this.w, this.h, lv.x, lv.y);
    this.emitMarks(lv, true);
  }

  /** The selected keys while the selection is relevant (a key among the loaded rows'), else null. */
  private selectedKeys(f: GeoFrame): ReadonlySet<string> | null {
    const sel = this.selection;
    if (sel === null || sel.keys.length === 0) return null;
    const s = this.selected;
    if (s?.frame === f && s.sel === sel) return s.keys;
    const want = new Set(sel.keys);
    const keys = f.rows.some((r) => want.has(r.key)) ? want : null;
    this.selected = { frame: f, sel, keys };
    return keys;
  }

  /** ADR-0027 (4): forced after a commit, on the first draw, new data and a level change; else on change. */
  private emitMarks(lv: Level, levelChanged: boolean): void {
    const force = this.forceMarks || levelChanged;
    this.forceMarks = false;
    const { w, h } = this;
    const inView = (i: number): boolean => {
      const x = lv.x[i] ?? NaN;
      const y = lv.y[i] ?? NaN;
      return x >= 0 && x <= w && y >= 0 && y <= h;
    };
    const last = this.lastMarks;
    if (
      !force &&
      last !== null &&
      last.level === lv.z &&
      last.marks.length === lv.keyboard.length
    ) {
      let same = true;
      for (let k = 0; k < lv.keyboard.length && same; k++) {
        const i = lv.keyboard[k] ?? 0;
        const m = lv.marks[i];
        const o = last.marks[k];
        same =
          m !== undefined &&
          o !== undefined &&
          o.id === m.id &&
          o.kind === m.kind &&
          o.inView === inView(i) &&
          o.keys.length === m.keys.length &&
          o.keys.every((x, j) => x === m.keys[j]);
      }
      if (same) return;
    }
    const marks = Array.from(lv.keyboard, (i) => {
      const m = lv.marks[i] as LaidMark;
      return { id: m.id, kind: m.kind, keys: m.keys, inView: inView(i) };
    });
    const ev: GeoMarksEvent = { level: lv.z, marks };
    this.lastMarks = ev;
    this.d.emit('geoMarks', ev);
  }

  private summary(lv: Level | null): FrameSummary {
    const f = this.frame;
    return {
      kind: 'geomap',
      geo: {
        view: this.ctl.committed,
        bounds: boundsOf(this.ctl.committedCamera, this.w, this.h),
        level: lv?.z ?? Math.floor(this.ctl.camera.z),
        marks: lv?.marks.length ?? 0,
        clusters: lv?.clusters ?? 0,
      },
      seriesTotal: f?.rows.length ?? 0,
      seriesShown: f?.shown.length ?? 0,
      fromMs: 0,
      toMs: 0,
      min: this.stats.min,
      max: this.stats.max,
      last: this.stats.last,
      plot: { x: 0, y: 0, width: this.w, height: this.h },
      valueAxis: null,
      thresholdLabels: [],
      eventLabels: [],
      ...(f === null ? {} : { coverage: f.coverage }),
    };
  }
}
