/**
 * The chart frame seam (ADR-0014 §3). Every chart is drawn by a `ChartEngine` through this
 * interface only: the interim Canvas 2D engine now, the Rust/WASM engine later (#68), which changes
 * only `engine/index.ts`. Specs and data are validated values, never code. Events report what the
 * engine saw; the application owns the Context and the URL (ADR-0014 §2).
 */
import type { FrameData } from '../data/frames';
import type { Unit } from '../i18n/format';
export type { FrameData, SeriesFrame, HeatmapFrame, ScalarFrame } from '../data/frames';
export type { Unit } from '../i18n/format';

export type ThemeName = 'dark' | 'light';
export type VisKind = 'line' | 'bars' | 'heatmap' | 'stat';
export interface TimeWindow {
  readonly fromMs: number;
  readonly toMs: number;
}

/** Validated data, never code. One axis per side; the time axis is the Context window. */
export type VisSpec =
  | { readonly kind: 'line'; readonly title: string; readonly unit: Unit }
  | {
      readonly kind: 'bars';
      readonly title: string;
      readonly unit: Unit;
      /** More modes later; one value now. */
      readonly stacking: 'normal';
      /** The label naming the category, e.g. `level`. */
      readonly categoryLabel: string;
      /** Bottom-to-top stack order only; colour is per series. */
      readonly categoryOrder: readonly string[];
    }
  | {
      readonly kind: 'heatmap';
      readonly title: string;
      readonly unit: Unit;
      readonly countUnit: Unit;
    }
  | { readonly kind: 'stat'; readonly title: string; readonly unit: Unit };

export interface FrameInit {
  /** IANA zone for the time axis. */
  readonly timeZone: string;
  /** Keydown source for the crosshair; null for stat. */
  readonly keyTarget: HTMLElement | null;
}

/** CSS px, relative to the canvas. */
export interface PlotRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface HoverRow {
  readonly key: string;
  readonly name: string;
  /** 0..7 → series-1..8; null for heatmap rows. */
  readonly colourIndex: number | null;
  readonly value: number;
}

export interface HoverEvent {
  readonly source: 'pointer' | 'keyboard';
  /** The snapped sample or bucket start. */
  readonly tMs: number;
  readonly xCss: number;
  readonly yCss: number;
  /** Every shown series, in draw order; NaN samples omitted. */
  readonly rows: readonly HoverRow[];
}

export interface BrushEvent {
  readonly fromMs: number;
  readonly toMs: number;
  readonly gesture: 'drag' | 'zoomOut';
}

/** Reserved; the Canvas 2D engine never emits it. */
export interface SelectEvent {
  readonly key: string;
  readonly tMs: number;
}

export interface FrameSummary {
  readonly kind: VisKind;
  /** Heatmap: buckets; bars: categories; stat: 1. */
  readonly seriesTotal: number;
  readonly seriesShown: number;
  readonly fromMs: number;
  readonly toMs: number;
  readonly min: number | null;
  readonly max: number | null;
  readonly last: number | null;
  readonly plot: PlotRect;
}

export interface FrameEvents {
  hover: HoverEvent | null;
  brush: BrushEvent;
  select: SelectEvent;
  a11y: FrameSummary;
}

export interface ChartEngine {
  createFrame(canvas: HTMLCanvasElement, init: FrameInit): ChartFrame;
}

export interface ChartFrame {
  setSpec(spec: VisSpec): void;
  setData(data: FrameData): void;
  setTimeWindow(w: TimeWindow): void;
  setTheme(t: ThemeName): void;
  resize(cssWidth: number, cssHeight: number, dpr: number): void;
  on<E extends keyof FrameEvents>(e: E, cb: (ev: FrameEvents[E]) => void): () => void;
  dispose(): void;
}
