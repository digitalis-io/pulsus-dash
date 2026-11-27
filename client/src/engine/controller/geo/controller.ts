/**
 * The geomap's camera and input controller (ADR-0027, ADR-0030, ADR-0031, T24-091; plan #234 Part 2
 * §3.2, §4.3–§4.5). Renderer-free, as `FrameController` is (ADR-0030): it listens on the canvas and
 * the key target, owns the camera (one Web Mercator world, `camera.ts`), runs the wheel, drag with
 * the T02 inertia, right-drag box, Alt+drag brush, click, hover, double-click and camera keys, eases
 * programmatic moves, and emits `hover`, `select`, `geoCommit` and `geoBrush`. It reads the marks of
 * the frame on screen through its `GeoStage`; any engine that paints a geomap reuses it.
 *
 * Programmatic moves (keys, fit, box, double-click, a changed spec view) ease 200 ms ease-out cubic,
 * or land at once under `motion: 'cut'` (reduced motion, VL-016). Each ease carries its origin:
 * stopping a `user` ease or the inertia commits what moved; stopping a `spec` ease commits nothing.
 * Any new pointer-down, wheel or camera key first stops a running ease or inertia at its pose.
 */
import type { CameraKey, GeoCommitEvent, GeoMapSpec, GeoView, PlotRect } from '../../api';
import {
  DRAG_MIN_PX,
  listen,
  PAGE_WHEEL_LATCH_MS,
  WHEEL_IDLE_MS,
  wheelIntent,
  type Handler,
} from '../input';
import { FLING_MIN_SPEED, releaseVelocity, spring, springEnd, type MoveSample } from '../inertia';
import type { ControllerDeps, Point } from '../stage';
import {
  boundsOf,
  camOf,
  contain,
  fitBox,
  fitView,
  fromPx,
  panPx,
  sameView,
  toPx,
  viewOf,
  zoomAbout,
  Z_MAX,
  type Cam,
  type WorldPoint,
} from './camera';
import type { LaidMark } from './marks';
import { marksInBox, pickMark, placeMarks } from './pick';
import { worldPx } from './project';

export type { LaidMark } from './marks';

/** What the controller reads of the frame it drives. */
export interface GeoStage {
  /** Pickable marks of the current level, draw order. */
  marks(): readonly LaidMark[];
  /** The shown rows' world positions (fit). */
  shown(): readonly WorldPoint[];
  /** A row's world position (a cluster's members), or null when it is not placed. */
  rowWorld(row: number): WorldPoint | null;
  redraw(): void;
}

/** A programmatic move's length, ms (INT-004: ≤ 250 ms). */
export const EASE_MS = 200;
/** Samples older than this are dropped while a drag runs, ms. */
const SAMPLE_KEEP_MS = 200;
/** A spec view moves the camera only when it changed by more than this. */
const VIEW_EPS = 1e-9;

type Gesture = GeoCommitEvent['gesture'];

interface Ease {
  readonly kind: 'ease';
  readonly from: Cam;
  readonly to: Cam;
  readonly start: number;
  readonly origin: 'user' | 'spec';
  /** The commit at its end or stop (`user` only). */
  readonly gesture: Gesture | null;
  /** A zoom re-anchors here every frame; null interpolates the centre and zoom. */
  readonly anchor: Point | null;
}

interface Fling {
  readonly kind: 'fling';
  /** The pose at the press: the gesture commits only if the view moved from it. */
  readonly from: Cam;
  readonly base: Cam;
  readonly vx: number;
  readonly vy: number;
  readonly start: number;
  liveX: boolean;
  liveY: boolean;
}

interface Press {
  readonly kind: 'pan' | 'box' | 'brush';
  readonly pointerId: number;
  readonly x0: number;
  readonly y0: number;
  x: number;
  y: number;
  moved: boolean;
  readonly cam0: Cam;
  readonly samples: MoveSample[];
}

const easeOut = (k: number): number => 1 - (1 - k) ** 3;

function sameSpecView(a: GeoView | null, b: GeoView | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    Math.abs(a.lat - b.lat) <= VIEW_EPS &&
    Math.abs(a.lon - b.lon) <= VIEW_EPS &&
    Math.abs(a.zoom - b.zoom) <= VIEW_EPS
  );
}

const sameCam = (a: Cam, b: Cam): boolean => a.u === b.u && a.v === b.v && a.z === b.z;

export class GeoController {
  private spec: GeoMapSpec | null = null;
  private w = 0;
  private h = 0;
  /** The previewed camera (what is drawn). */
  private cam: Cam = camOf({ lat: 20, lon: 0, zoom: 0 });
  /** The camera of the last commit or external input. */
  private settled: Cam = this.cam;
  /** A camera exists: a spec and a non-empty plot arrived. */
  private ready = false;
  /** The view is null and nothing was committed since: data and resizes refit. */
  private follow = false;
  private lastSpecView: GeoView | null = null;
  private motion: Ease | Fling | null = null;
  private press: Press | null = null;
  private wheel: { timer: number; readonly start: Cam } | null = null;
  private focusId: string | null = null;
  private hovered: { id: string; x: number; y: number } | null = null;
  private rightPress = false;
  private rightTimer: number | null = null;
  private disposed = false;
  private readonly canvasHandlers: readonly Handler[];
  private readonly keyHandlers: readonly Handler[];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly keyTarget: HTMLElement | null,
    private readonly stage: GeoStage,
    private readonly deps: ControllerDeps,
  ) {
    this.canvasHandlers = [
      listen('pointerdown', this.onPointerDown.bind(this)),
      listen('pointermove', this.onPointerMove.bind(this)),
      listen('pointerup', this.onPointerUp.bind(this)),
      listen('pointercancel', this.cancelPress.bind(this)),
      listen('lostpointercapture', this.cancelPress.bind(this)),
      listen('pointerleave', this.onPointerLeave.bind(this)),
      listen('dblclick', this.onDoubleClick.bind(this)),
      listen('contextmenu', this.onContextMenu.bind(this)),
      listen('wheel', this.onWheel.bind(this), { passive: false }),
    ];
    this.keyHandlers = [listen('keydown', this.onKeyDown.bind(this))];
    for (const [type, fn, opts] of this.canvasHandlers) canvas.addEventListener(type, fn, opts);
    for (const [type, fn] of this.keyHandlers) keyTarget?.addEventListener(type, fn);
  }

  /** The previewed view. */
  get view(): GeoView {
    return viewOf(this.cam);
  }

  /** The view of the last commit or external input (the summary's). */
  get committed(): GeoView {
    return viewOf(this.settled);
  }

  /** The camera as drawn, world units. */
  get camera(): Cam {
    return this.cam;
  }

  /** The camera of `committed`, world units. */
  get committedCamera(): Cam {
    return this.settled;
  }

  /** The band of a moved right or Alt drag, CSS px. */
  get box(): PlotRect | null {
    const g = this.press;
    if (g === null || !g.moved || g.kind === 'pan') return null;
    return {
      x: Math.min(g.x0, g.x),
      y: Math.min(g.y0, g.y),
      width: Math.abs(g.x - g.x0),
      height: Math.abs(g.y - g.y0),
    };
  }

  get boxKind(): 'fit' | 'brush' | null {
    const g = this.press;
    if (g === null || this.box === null) return null;
    return g.kind === 'box' ? 'fit' : 'brush';
  }

  get focusMark(): string | null {
    return this.focusId;
  }

  /** Ownership (§4.5): only a changed spec view moves the camera; non-null → null refits. */
  setSpec(s: GeoMapSpec): void {
    if (this.disposed) return;
    this.spec = s;
    const prev = this.lastSpecView;
    this.lastSpecView = s.view;
    if (!this.ready) {
      this.init();
      this.stage.redraw();
      return;
    }
    if (s.view === null) {
      if (prev !== null) {
        this.stopMotion();
        this.endWheel();
        this.refit();
      }
    } else if (!sameSpecView(prev, s.view)) {
      const to = contain(camOf(s.view), this.w, this.h);
      this.follow = false;
      if (!sameView(to, this.cam)) {
        this.stopMotion();
        this.endWheel();
        this.startEase(to, 'spec', null, null);
      }
    }
    this.stage.redraw();
  }

  /** New data: a following camera refits at once; the hover is cleared. */
  dataChanged(): void {
    if (this.disposed || !this.ready) return;
    this.clearHover();
    if (this.follow) this.refit();
    this.stage.redraw();
  }

  /** The zoom raised to zMin and contained; a following camera refits. */
  resize(w: number, h: number): void {
    if (this.disposed) return;
    this.w = w;
    this.h = h;
    if (!this.ready) {
      this.init();
      this.stage.redraw();
      return;
    }
    this.clearHover();
    if (this.follow) {
      this.refit();
    } else {
      this.cam = contain(this.cam, w, h);
      const m = this.motion;
      if (m?.kind === 'ease') this.motion = { ...m, to: contain(m.to, w, h) };
    }
    this.stage.redraw();
  }

  setFocusMark(id: string | null): void {
    if (this.disposed || id === this.focusId) return;
    this.focusId = id;
    this.stage.redraw();
  }

  /** One camera key (ADR-0027 §5): in/out about the focus mark when in view, fit, or a 25 % pan. */
  cameraKey(k: CameraKey): void {
    if (this.disposed || !this.ready) return;
    this.stopMotion();
    this.endWheel();
    const { w, h } = this;
    const c = this.cam;
    switch (k) {
      case 'in':
      case 'out': {
        const a = this.focusAnchor() ?? { x: w / 2, y: h / 2 };
        this.startEase(zoomAbout(c, k === 'in' ? 1 : -1, a.x, a.y, w, h), 'user', 'keys', a);
        return;
      }
      case 'fit':
        this.startEase(this.fit(), 'user', 'fit', null);
        return;
      case 'panLeft':
        this.startEase(panPx(c, -w / 4, 0, w, h), 'user', 'keys', null);
        return;
      case 'panRight':
        this.startEase(panPx(c, w / 4, 0, w, h), 'user', 'keys', null);
        return;
      case 'panUp':
        this.startEase(panPx(c, 0, -h / 4, w, h), 'user', 'keys', null);
        return;
      case 'panDown':
        this.startEase(panPx(c, 0, h / 4, w, h), 'user', 'keys', null);
        return;
    }
  }

  /** Advances an ease or the inertia to `nowMs`; true while still moving. */
  tick(nowMs: number): boolean {
    const m = this.motion;
    if (m === null || this.disposed) return false;
    if (m.kind === 'ease') {
      const k = Math.min(1, Math.max(0, (nowMs - m.start) / EASE_MS));
      if (k < 1) {
        this.cam = this.easePose(m, k);
        return true;
      }
      this.cam = m.to;
      this.motion = null;
      this.endEase(m);
      return false;
    }
    const t = nowMs - m.start;
    const done = spring(m.vx, t).done && spring(m.vy, t).done;
    this.cam = this.flingPose(m, t);
    if (done || (!m.liveX && !m.liveY)) {
      this.motion = null;
      this.commit('pan', m.from);
      return false;
    }
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.wheel !== null) this.deps.clearTimer(this.wheel.timer);
    this.wheel = null;
    this.motion = null;
    this.press = null;
    this.clearRightPress();
    for (const [type, fn] of this.canvasHandlers) this.canvas.removeEventListener(type, fn);
    for (const [type, fn] of this.keyHandlers) this.keyTarget?.removeEventListener(type, fn);
  }

  // Camera.

  private init(): void {
    const s = this.spec;
    if (this.ready || s === null || !(this.w > 0) || !(this.h > 0)) return;
    this.ready = true;
    if (s.view !== null) {
      this.cam = contain(camOf(s.view), this.w, this.h);
      this.follow = false;
    } else {
      this.cam = this.fit();
      this.follow = true;
    }
    this.settled = this.cam;
  }

  private fit(): Cam {
    return fitView(this.stage.shown(), this.w, this.h);
  }

  /** At once, no commit: the camera follows the data again. */
  private refit(): void {
    this.motion = null;
    this.cam = this.fit();
    this.settled = this.cam;
    this.follow = true;
  }

  private startEase(
    to: Cam,
    origin: Ease['origin'],
    gesture: Gesture | null,
    anchor: Point | null,
  ): void {
    const m: Ease = {
      kind: 'ease',
      from: this.cam,
      to,
      start: this.deps.now(),
      origin,
      gesture,
      anchor,
    };
    if (this.spec?.motion === 'cut') {
      this.cam = to;
      this.endEase(m);
    } else {
      this.motion = m;
    }
    this.stage.redraw();
  }

  private endEase(m: Ease): void {
    if (m.origin === 'user' && m.gesture !== null) this.commit(m.gesture, m.from);
    else this.settled = this.cam;
  }

  private easePose(m: Ease, k: number): Cam {
    const e = easeOut(k);
    const { from, to } = m;
    if (m.anchor !== null) {
      return zoomAbout(from, (to.z - from.z) * e, m.anchor.x, m.anchor.y, this.w, this.h);
    }
    return contain(
      {
        u: from.u + (to.u - from.u) * e,
        v: from.v + (to.v - from.v) * e,
        z: from.z + (to.z - from.z) * e,
      },
      this.w,
      this.h,
    );
  }

  /** The inertia's pose `t` ms after release; a contained axis stops its own motion. */
  private flingPose(m: Fling, t: number): Cam {
    const S = worldPx(m.base.z);
    const raw = {
      u: m.base.u - spring(m.vx, t).offset / S,
      v: m.base.v - spring(m.vy, t).offset / S,
      z: m.base.z,
    };
    const c = contain(raw, this.w, this.h);
    if (c.u !== raw.u) m.liveX = false;
    if (c.v !== raw.v) m.liveY = false;
    return c;
  }

  /** Stops a running ease or inertia at its current pose; a `user` ease or a fling commits. */
  private stopMotion(): void {
    const m = this.motion;
    if (m === null) return;
    this.motion = null;
    if (m.kind === 'ease') this.endEase(m);
    else this.commit('pan', m.from);
    this.stage.redraw();
  }

  /**
   * A gesture that began at `from` ended: when the view moved, it is committed (`geoCommit`, the
   * data stops refitting) and a draw follows; an unmoved view commits nothing.
   */
  private commit(gesture: Gesture, from: Cam): void {
    if (sameCam(this.cam, from)) return;
    this.settled = this.cam;
    this.follow = false;
    this.stage.redraw();
    this.deps.emit('geoCommit', {
      view: viewOf(this.cam),
      bounds: boundsOf(this.cam, this.w, this.h),
      gesture,
    });
  }

  /** A release at (vx, vy) px/ms: the inertia, or its end offset at once under `cut`. */
  private fling(vx: number, vy: number, from: Cam): void {
    if (this.spec?.motion === 'cut') {
      this.cam = panPx(this.cam, -springEnd(vx), -springEnd(vy), this.w, this.h);
      this.commit('pan', from);
      return;
    }
    this.motion = {
      kind: 'fling',
      from,
      base: this.cam,
      vx,
      vy,
      start: this.deps.now(),
      liveX: vx !== 0,
      liveY: vy !== 0,
    };
  }

  /** The focus mark's centre when it is in view. */
  private focusAnchor(): Point | null {
    const id = this.focusId;
    if (id === null) return null;
    const m = this.stage.marks().find((x) => x.id === id);
    if (m === undefined) return null;
    const p = toPx(this.cam, m.u, m.v, this.w, this.h);
    return p.x >= 0 && p.x <= this.w && p.y >= 0 && p.y <= this.h ? p : null;
  }

  private pickAt(p: Point): LaidMark | null {
    return pickMark(placeMarks(this.stage.marks(), this.cam, this.w, this.h), p.x, p.y);
  }

  // Input.

  private local(e: MouseEvent): Point {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private hoverAt(p: Point): void {
    const m = this.pickAt(p);
    if (m === null) {
      this.clearHover();
      return;
    }
    const c = toPx(this.cam, m.u, m.v, this.w, this.h);
    const h = this.hovered;
    if (h !== null && h.id === m.id && h.x === c.x && h.y === c.y) return;
    this.hovered = { id: m.id, x: c.x, y: c.y };
    this.deps.emit('hover', {
      source: 'pointer',
      tMs: null,
      xCss: c.x,
      yCss: c.y,
      rows: [],
      item: { kind: 'geo', id: m.id, keys: m.keys },
    });
  }

  private clearHover(): void {
    if (this.hovered === null) return;
    this.hovered = null;
    this.deps.emit('hover', null);
  }

  private endWheel(): void {
    const g = this.wheel;
    if (g === null) return;
    this.deps.clearTimer(g.timer);
    this.wheel = null;
    this.commit('wheel', g.start);
  }

  private onWheel(e: WheelEvent): void {
    const s = this.spec;
    if (!this.ready || s === null || !s.wheelZoom) return;
    if (this.press !== null) {
      // A wheel during a press is consumed and ignored.
      e.preventDefault();
      return;
    }
    // A page scroll already in progress keeps scrolling over the map (T02 §4.4).
    if (e.timeStamp - this.deps.wheelLatch.lastPageWheel() < PAGE_WHEEL_LATCH_MS) return;
    const intent = wheelIntent(e, { x: 0, y: 0, width: this.w, height: this.h });
    if (intent === null) return;
    e.preventDefault();
    this.stopMotion();
    const p = this.local(e);
    const g = this.wheel ?? { timer: -1, start: this.cam };
    this.deps.clearTimer(g.timer);
    g.timer = this.deps.setTimer(() => {
      this.endWheel();
    }, WHEEL_IDLE_MS);
    this.wheel = g;
    this.cam =
      intent.kind === 'zoom'
        ? zoomAbout(this.cam, -Math.log2(intent.factor), p.x, p.y, this.w, this.h)
        : panPx(this.cam, intent.fraction * this.w, 0, this.w, this.h);
    this.stage.redraw();
    this.hoverAt(p);
  }

  private onPointerDown(e: PointerEvent): void {
    if (!this.ready || e.pointerType === 'touch') return;
    this.clearRightPress();
    const kind: Press['kind'] | null =
      e.button === 2
        ? 'box'
        : e.button === 0 && e.altKey
          ? 'brush'
          : e.button === 0 && !(e.ctrlKey && !e.metaKey)
            ? 'pan'
            : null;
    if (e.button === 2) this.rightPress = true;
    // Any press first stops a running move at its pose (§4.3, interruption).
    this.stopMotion();
    this.endWheel();
    if (kind === null || this.press !== null) return;
    e.preventDefault();
    const p = this.local(e);
    const target: { setPointerCapture?: (id: number) => void } = this.canvas;
    try {
      target.setPointerCapture?.(e.pointerId);
    } catch {
      // Capture is best effort (jsdom has none).
    }
    this.press = {
      kind,
      pointerId: e.pointerId,
      x0: p.x,
      y0: p.y,
      x: p.x,
      y: p.y,
      moved: false,
      cam0: this.cam,
      samples: [{ t: this.deps.now(), x: p.x, y: p.y }],
    };
    this.canvas.dataset['gesture'] = kind;
    this.clearHover();
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.ready) return;
    const p = this.local(e);
    const g = this.press;
    if (g === null) {
      this.hoverAt(p);
      return;
    }
    if (e.pointerId !== g.pointerId) return;
    g.x = p.x;
    g.y = p.y;
    const now = this.deps.now();
    g.samples.push({ t: now, x: p.x, y: p.y });
    while ((g.samples[0]?.t ?? now) < now - SAMPLE_KEEP_MS) g.samples.shift();
    if (!g.moved) {
      if (Math.hypot(p.x - g.x0, p.y - g.y0) < DRAG_MIN_PX) return;
      g.moved = true;
    }
    // The content follows the pointer.
    if (g.kind === 'pan') this.cam = panPx(g.cam0, -(p.x - g.x0), -(p.y - g.y0), this.w, this.h);
    this.stage.redraw();
  }

  private onPointerUp(e: PointerEvent): void {
    if (this.rightPress) this.armRightClear();
    const g = this.press;
    if (g === null || e.pointerId !== g.pointerId) return;
    this.press = null;
    delete this.canvas.dataset['gesture'];
    const p = this.local(e);
    if (!g.moved) {
      // T25-005: a click selects the mark under it (null: an empty click).
      if (g.kind === 'pan' && Math.hypot(p.x - g.x0, p.y - g.y0) < DRAG_MIN_PX) {
        const m = this.pickAt(p);
        this.deps.emit('select', {
          source: 'pointer',
          item: m === null ? null : { kind: 'geo', id: m.id, keys: m.keys },
        });
      }
      return;
    }
    const { w, h } = this;
    switch (g.kind) {
      case 'pan': {
        const now = this.deps.now();
        g.samples.push({ t: now, x: p.x, y: p.y });
        this.cam = panPx(g.cam0, -(p.x - g.x0), -(p.y - g.y0), w, h);
        const v = releaseVelocity(g.samples, now);
        if (Math.hypot(v.vx, v.vy) > FLING_MIN_SPEED) this.fling(v.vx, v.vy, g.cam0);
        else this.commit('pan', g.cam0);
        break;
      }
      case 'box': {
        const a = fromPx(this.cam, g.x0, g.y0, w, h);
        const b = fromPx(this.cam, p.x, p.y, w, h);
        this.startEase(fitBox(a, b, w, h), 'user', 'box', null);
        break;
      }
      case 'brush': {
        const band = {
          x: Math.min(g.x0, p.x),
          y: Math.min(g.y0, p.y),
          width: Math.abs(p.x - g.x0),
          height: Math.abs(p.y - g.y0),
        };
        const keys = marksInBox(placeMarks(this.stage.marks(), this.cam, w, h), band);
        this.deps.emit('geoBrush', { keys });
        break;
      }
    }
    this.stage.redraw();
  }

  /** `pointercancel`, `lostpointercapture`: the press ends; a pan returns to where it began. */
  private cancelPress(): void {
    const g = this.press;
    if (g === null) return;
    this.press = null;
    delete this.canvas.dataset['gesture'];
    if (g.kind === 'pan') this.cam = g.cam0;
    this.stage.redraw();
  }

  private onPointerLeave(): void {
    if (this.press === null) this.clearHover();
  }

  private onContextMenu(e: Event): void {
    if (!this.rightPress) return;
    // A right drag is the box: no browser menu.
    e.preventDefault();
    this.clearRightPress();
  }

  /** `rightPress` lasts until a 0 ms timer after its `pointerup` (the Windows event order). */
  private armRightClear(): void {
    if (this.rightTimer !== null) this.deps.clearTimer(this.rightTimer);
    this.rightTimer = this.deps.setTimer(() => {
      this.rightTimer = null;
      this.rightPress = false;
    }, 0);
  }

  private clearRightPress(): void {
    this.rightPress = false;
    if (this.rightTimer !== null) this.deps.clearTimer(this.rightTimer);
    this.rightTimer = null;
  }

  /** On a cluster: fit its members (inset p, up to zoom 14); else zoom ×2 about the pointer. */
  private onDoubleClick(e: MouseEvent): void {
    if (!this.ready) return;
    this.stopMotion();
    this.endWheel();
    const p = this.local(e);
    const m = this.pickAt(p);
    const { w, h } = this;
    if (m?.kind === 'cluster') {
      const pts: WorldPoint[] = [];
      for (const r of m.rows) {
        const q = this.stage.rowWorld(r);
        if (q !== null) pts.push(q);
      }
      this.startEase(fitView(pts, w, h, Z_MAX), 'user', 'dblclick', null);
      return;
    }
    this.startEase(zoomAbout(this.cam, 1, p.x, p.y, w, h), 'user', 'dblclick', p);
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.target !== this.keyTarget || e.ctrlKey || e.metaKey || e.altKey) return;
    let k: CameraKey | null = null;
    switch (e.key) {
      case '+':
      case '=':
        k = 'in';
        break;
      case '-':
        k = 'out';
        break;
      case '0':
        k = 'fit';
        break;
      case 'ArrowLeft':
        k = e.shiftKey ? 'panLeft' : null;
        break;
      case 'ArrowRight':
        k = e.shiftKey ? 'panRight' : null;
        break;
      case 'ArrowUp':
        k = e.shiftKey ? 'panUp' : null;
        break;
      case 'ArrowDown':
        k = e.shiftKey ? 'panDown' : null;
        break;
    }
    if (k === null) return;
    // Handled keys are prevented; propagation is kept (the T25-007 ladder sees the rest).
    e.preventDefault();
    this.cameraKey(k);
  }
}
