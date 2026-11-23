/**
 * The chart frame seam (ADR-0014 §3, amended by ADR-0019, ADR-0020 and ADR-0022). Every chart is drawn by a `ChartEngine`
 * through this interface only: the interim Canvas 2D engine now, the Rust/WASM engine later (#68), which changes
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

/** A value-axis range in data units; `min < max`, both finite. */
export interface ValueRange {
  readonly min: number;
  readonly max: number;
}

export type ThresholdState = 'watch' | 'degraded' | 'failing';

/** A horizontal threshold on the value axis (T02-009: the default axis; ADR-0022). */
export interface ThresholdLine {
  /** Data units; a non-finite value is not drawn. */
  readonly value: number;
  readonly state: ThresholdState;
  /** Display text, drawn after the state glyph; plain text, never markup. */
  readonly label: string;
}

/** Validated data, never code. One axis per side; the time axis is the Context window. */
export type VisSpec =
  | {
      readonly kind: 'line';
      readonly title: string;
      readonly unit: Unit;
      /** The user's value-axis pin (#93); absent = auto. */
      readonly valueRange?: ValueRange;
      /** Absent = none; at most 8 are drawn, in order (ADR-0022). */
      readonly thresholds?: readonly ThresholdLine[];
    }
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
      /** The user's value-axis pin (#93); absent = auto. */
      readonly valueRange?: ValueRange;
      /** Absent = none; at most 8 are drawn, in order, on the stacked value axis (ADR-0022). */
      readonly thresholds?: readonly ThresholdLine[];
    }
  | {
      readonly kind: 'heatmap';
      readonly title: string;
      readonly unit: Unit;
      readonly countUnit: Unit;
    }
  /** With series data, a sparkline of the first series is drawn under the value (ADR-0022). */
  | { readonly kind: 'stat'; readonly title: string; readonly unit: Unit };

export interface FrameInit {
  /** IANA zone for the time axis. */
  readonly timeZone: string;
  /** Keydown source for the crosshair; null for stat. */
  readonly keyTarget: HTMLElement | null;
  /** Diagnostic identity of the frame: tags its `chart-draw` measures (#90, ADR-0019). */
  readonly id?: string;
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

/** A committed camera move (T03 §4.4): the gesture ended and changed the view. */
export interface CommitEvent {
  /** The new absolute window, whole ms, `fromMs < toMs`; null when the gesture did not move time. */
  readonly window: TimeWindow | null;
  /** A new manual value range; `'auto'` clears the pin; null when the gesture did not move values. */
  readonly value: ValueRange | 'auto' | null;
  readonly gesture: 'wheel' | 'pan' | 'axis' | 'fit';
}

/** Reserved; the Canvas 2D engine never emits it. */
export interface SelectEvent {
  readonly key: string;
  readonly tMs: number;
}

/** A threshold label as laid out (ADR-0022), CSS px relative to the canvas. */
export interface ThresholdLabelBox {
  readonly box: PlotRect;
  /** The full text: `${glyph} ${label}`, or for an overflow chip every hidden label, joined by '; '. */
  readonly text: string;
  /** Truncated with an ellipsis, or an overflow chip (`+N`): the DOM shows `text` on hover/focus. */
  readonly clipped: boolean;
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
  /** The drawn value axis (line, bars); null for heatmap and stat. */
  readonly valueAxis: {
    readonly min: number;
    readonly max: number;
    readonly manual: boolean;
  } | null;
  /** The threshold labels in stack order (line, bars; [] otherwise; ADR-0022). */
  readonly thresholdLabels: readonly ThresholdLabelBox[];
}

/** The visible canvas was drawn completely at this size (#90, ADR-0019). */
export interface DrawnEvent {
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly dpr: number;
}

export interface FrameEvents {
  hover: HoverEvent | null;
  brush: BrushEvent;
  select: SelectEvent;
  a11y: FrameSummary;
  drawn: DrawnEvent;
  commit: CommitEvent;
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
