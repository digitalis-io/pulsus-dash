/**
 * The geomap's camera and input controller (ADR-0027, ADR-0030, ADR-0031, T24-091; plan #234 Part 2
 * §3.2, §4.3–§4.5): renderer-free, so any engine that paints a geomap reuses it.
 */
import type { CameraKey, GeoMapSpec, GeoView, PlotRect } from '../../api';
import type { ControllerDeps } from '../stage';
import type { WorldPoint } from './camera';
import type { LaidMark } from './marks';

export type { LaidMark } from './marks';

/** What the controller reads of the frame it drives. */
export interface GeoStage {
  /** Pickable marks of the current level, draw order. */
  marks(): readonly LaidMark[];
  /** The shown rows' world positions (fit). */
  shown(): readonly WorldPoint[];
  redraw(): void;
}

export class GeoController {
  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly keyTarget: HTMLElement | null,
    private readonly stage: GeoStage,
    private readonly deps: ControllerDeps,
  ) {
    void this.canvas;
    void this.keyTarget;
    void this.stage;
    void this.deps;
  }

  get view(): GeoView {
    return { lat: 20, lon: 0, zoom: 0 };
  }
  get committed(): GeoView {
    return { lat: 20, lon: 0, zoom: 0 };
  }
  get box(): PlotRect | null {
    return null;
  }
  get boxKind(): 'fit' | 'brush' | null {
    return null;
  }
  setSpec(s: GeoMapSpec): void {
    void s;
  }
  dataChanged(): void {}
  resize(w: number, h: number): void {
    void w;
    void h;
  }
  setFocusMark(id: string | null): void {
    void id;
  }
  cameraKey(k: CameraKey): void {
    void k;
  }
  tick(nowMs: number): boolean {
    void nowMs;
    return false;
  }
  dispose(): void {}
}
