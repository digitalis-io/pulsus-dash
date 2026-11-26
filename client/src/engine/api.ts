/**
 * The chart frame seam (ADR-0014 §3, amended by ADR-0019, ADR-0020, ADR-0022, ADR-0023, ADR-0025 and ADR-0028). Every chart is drawn by a `ChartEngine`
 * through this interface only: the interim Canvas 2D engine now, the Rust/WASM engine later (#68), which changes
 * only `engine/index.ts`. Specs and data are validated values, never code. Events report what the
 * engine saw; the application owns the Context and the URL (ADR-0014 §2).
 */
import type { Coverage, FrameData } from '../data/frames';
import type { Unit } from '../i18n/format';
export type {
  CategoryRow,
  Coverage,
  FrameData,
  SeriesFrame,
  HeatmapFrame,
  ScalarFrame,
} from '../data/frames';
export type { Unit } from '../i18n/format';

export type ThemeName = 'dark' | 'light';
/** I3 adds `pie` (T22). */
export type VisKind = 'line' | 'bars' | 'heatmap' | 'stat' | 'barchart';
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

/**
 * A bar chart of reduced categories (ADR-0028, T22 §5.1): one bar per `categories` row, in data
 * order. The panel's fit (`vis/barchart.ts`) sets `names` and may lower `valueLabels`.
 */
export interface BarchartSpec {
  readonly kind: 'barchart';
  readonly title: string;
  readonly unit: Unit;
  readonly orientation: 'horizontal' | 'vertical';
  readonly valueLabels: boolean;
  /** Set by the fit (plan #173 Part 2 §3.4 step 7): no category names are drawn. */
  readonly names?: 'hidden';
  /** Absent = auto: [min(0, drawn, thresholds), max(0, …)], nice-rounded. */
  readonly valueRange?: ValueRange;
  /** Absent = none; at most 8 are drawn, in order (ADR-0022). */
  readonly thresholds?: readonly ThresholdLine[];
  /** A dashed bar at each finite baseline. */
  readonly ghost: boolean;
  /** Nothing is drawn until Epic #9. */
  readonly anomaly: boolean;
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
  | { readonly kind: 'stat'; readonly title: string; readonly unit: Unit }
  | BarchartSpec;

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

/**
 * The page selection a frame draws (ADR-0025, T25-006): series or stream keys and an optional
 * interval [fromMs, toMs). Empty keys and a null interval leave every mark as it was.
 */
export interface FrameSelection {
  readonly keys: readonly string[];
  readonly fromMs: number | null;
  readonly toMs: number | null;
}

/** The mark under a click or the keyboard crosshair (ADR-0025; T21 adds `segment`). */
export type HoverItem =
  | { readonly kind: 'point'; readonly key: string; readonly tMs: number; readonly value: number }
  | {
      readonly kind: 'bucket';
      /** The bound index. */
      readonly index: number;
      readonly tMs: number;
      readonly toMs: number;
      readonly count: number;
    };

/** A click on the plot (ADR-0025): the mark under it, or null for an empty click. */
export interface SelectEvent {
  readonly source: 'pointer' | 'keyboard';
  readonly item: HoverItem | null;
}

/** A threshold label as laid out (ADR-0022), CSS px relative to the canvas. */
export interface ThresholdLabelBox {
  readonly box: PlotRect;
  /** The full text: `${glyph} ${label}`, or for an overflow chip every hidden label, joined by '; '. */
  readonly text: string;
  /** Truncated with an ellipsis, or an overflow chip (`+N`): the DOM shows `text` on hover/focus. */
  readonly clipped: boolean;
}

export type EventKind = 'deploy' | 'config' | 'flag' | 'annotation';

/** A deploy or event marker on the time axis (ADR-0023): a vertical line with a label above the plot. */
export interface EventMarker {
  readonly id: string;
  /** ms since the epoch; a non-finite value is not drawn. */
  readonly atMs: number;
  /** The end of a ranged event, ms; null for a point. Tooltip only. */
  readonly endMs: number | null;
  readonly kind: EventKind;
  /** Plain text, never markup (T02-019). */
  readonly title: string;
}

/** An event label as laid out (ADR-0023), CSS px relative to the canvas. */
export interface EventLabelBox {
  readonly box: PlotRect;
  /** CSS px of the first member's line. */
  readonly x: number;
  /** The members, in (atMs, id) order. */
  readonly ids: readonly string[];
  /** The full label of each member, joined by '; '. */
  readonly text: string;
  /** Truncated, or a `+N` chip: the DOM shows `text` on hover and focus. */
  readonly clipped: boolean;
}

export interface FrameSummary {
  readonly kind: VisKind;
  /** Heatmap: buckets; bars: categories; stat: 1; barchart: `coverage.total`. */
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
  /** The event labels in x order (line, bars, heatmap; [] for stat; ADR-0023). */
  readonly eventLabels: readonly EventLabelBox[];
  /** The frame data's coverage, copied (categories only; ADR-0028). */
  readonly coverage?: Coverage;
  /** Barchart: no category names were drawn (T22-004). */
  readonly namesHidden?: true;
  /** Barchart: no value labels were drawn (the spec's `valueLabels` is false). */
  readonly valuesHidden?: true;
}

/**
 * The facts a panel's summary states (T21 §5): `extent` is null for kinds without one; the
 * histogram fills it with the drawable minimum and maximum (T21-015).
 */
export interface SummaryFacts {
  readonly subject: string;
  readonly current: { readonly text: string; readonly series: string } | null;
  readonly change: {
    readonly series: string;
    readonly from: string;
    readonly to: string;
    readonly atMs: number;
  } | null;
  readonly extent: { readonly min: number; readonly max: number } | null;
  /** Null until baselines (ADR-0012). */
  readonly baselineRatio: number | null;
}

/**
 * The bar under the pointer or the keyboard focus (ADR-0028): its key, its draw index, the value end
 * and band centre of the bar (CSS px), and one row (`colourIndex` null when state-coloured).
 */
export interface MarkEvent {
  readonly source: 'pointer' | 'keyboard';
  readonly key: string;
  /** Draw order. */
  readonly index: number;
  readonly xCss: number;
  readonly yCss: number;
  readonly rows: readonly HoverRow[];
}

/** A click on a bar (`keys` = [its key]) or on no bar (`[]`), or a brush (Part 3; ADR-0028). */
export interface PickEvent {
  readonly keys: readonly string[];
  readonly gesture: 'click' | 'brush';
  readonly source: 'pointer' | 'keyboard';
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
  mark: MarkEvent | null;
  pick: PickEvent;
}

export interface ChartEngine {
  createFrame(canvas: HTMLCanvasElement, init: FrameInit): ChartFrame;
}

export interface ChartFrame {
  setSpec(spec: VisSpec): void;
  setData(data: FrameData): void;
  setTimeWindow(w: TimeWindow): void;
  setTheme(t: ThemeName): void;
  /** Replaces the event markers; [] = none (ADR-0023). */
  setEvents(events: readonly EventMarker[]): void;
  /** The page selection drawn in the next frame; null = none; an equal value is ignored (ADR-0025). */
  setSelection(sel: FrameSelection | null): void;
  resize(cssWidth: number, cssHeight: number, dpr: number): void;
  on<E extends keyof FrameEvents>(e: E, cb: (ev: FrameEvents[E]) => void): () => void;
  dispose(): void;
}
