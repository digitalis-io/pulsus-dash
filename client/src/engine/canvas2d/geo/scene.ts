/**
 * The geomap scene of the Canvas 2D engine (ADR-0027; plan #234 Part 2 §3.1): the dynamic entry
 * that owns the geo controller and the painter, and emits the geo events and the summary.
 */
import type {
  CameraKey,
  FrameSelection,
  FrameSummary,
  GeoMapSpec,
  ThemeName,
} from '../../api';
import type { Emit } from '../../controller/stage';
import type { GeoFrame } from '../../../vis/geo/frame';
import type { Ctx2D } from '../ctx';
import type { WheelLatch } from '../input';

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

export function createGeoScene(d: GeoSceneDeps): GeoScene {
  void d;
  const summary: FrameSummary = {
    kind: 'geomap',
    geo: null,
    seriesTotal: 0,
    seriesShown: 0,
    fromMs: 0,
    toMs: 0,
    min: null,
    max: null,
    last: null,
    plot: { x: 0, y: 0, width: 0, height: 0 },
    valueAxis: null,
    thresholdLabels: [],
    eventLabels: [],
  };
  return {
    setSpec: () => undefined,
    setData: () => undefined,
    setSelection: () => undefined,
    setTheme: () => undefined,
    resize: () => undefined,
    setFocusMark: () => undefined,
    cameraKey: () => undefined,
    draw: () => summary,
    animating: () => false,
    dispose: () => undefined,
  };
}
