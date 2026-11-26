/**
 * Widget panels (plan #198 Part 1 §3.3; T24-002, T24-003, T24 §5.1): the widget kinds, the kinds
 * not drawn yet, the guards that split a panel into a data panel (with a query) and a widget
 * (without one), and the text and clock options with their defaults.
 */
import type {
  ClockCountdown,
  ClockZone,
  CodeLanguage,
  DataPanelSpec,
  PanelSpec,
  PanelVisKind,
  VisOptions,
  WidgetKind,
  WidgetPanelSpec,
} from '../api/types';

/** The kinds without a query (the Go `widgetKinds`). */
export const WIDGET_KINDS: ReadonlySet<PanelVisKind> = new Set<PanelVisKind>(['text', 'clock']);

/**
 * The widget kinds this version does not draw yet: such a panel shows `widget.kindUnavailable`.
 * Text until #198 Part 3, clock until A2.
 */
export const PENDING_WIDGETS: ReadonlySet<WidgetKind> = new Set<WidgetKind>(['text', 'clock']);

/** Whether `kind` is a widget kind. */
export function isWidgetKind(kind: PanelVisKind): kind is WidgetKind {
  return WIDGET_KINDS.has(kind);
}

export function isWidgetPanel(p: PanelSpec): p is WidgetPanelSpec {
  return isWidgetKind(p.vis.kind);
}

export function isDataPanel(p: PanelSpec): p is DataPanelSpec {
  return !isWidgetKind(p.vis.kind);
}

export interface TextOptions {
  readonly mode: 'markdown' | 'code';
  readonly content: string;
  readonly language: CodeLanguage;
}

export const DEFAULT_TEXT_MODE = 'markdown';

/** Whether `v` is a text mode (stub). */
export function isTextMode(v: unknown): v is TextOptions['mode'] {
  return typeof v === 'string';
}

/** A text widget's options with the T24 §5.1 defaults: markdown, `''`, plaintext. */
export function textOptions(o?: VisOptions): TextOptions {
  return {
    mode: isTextMode(o?.mode) ? o.mode : DEFAULT_TEXT_MODE,
    content: o?.content ?? '',
    language: o?.language ?? 'plaintext',
  };
}

export interface ClockOptions {
  readonly zones: readonly ClockZone[];
  readonly hourCycle: 'auto' | 'h12' | 'h23';
  readonly seconds: boolean;
  readonly date: boolean;
  readonly countdown: ClockCountdown | null;
}

/** The default zones: one row in the Context zone (`tz: ''`) with the city as its label. */
const DEFAULT_ZONES: readonly ClockZone[] = Object.freeze([Object.freeze({ tz: '', label: '' })]);

/**
 * A clock's options with the T24 §5.1 defaults: one Context-zone row, `auto`, no seconds, the date
 * shown, no countdown.
 */
export function clockOptions(o?: VisOptions): ClockOptions {
  return {
    zones: o?.zones ?? DEFAULT_ZONES,
    hourCycle: o?.hourCycle ?? 'auto',
    seconds: o?.seconds ?? false,
    date: o?.date ?? true,
    countdown: o?.countdown ?? null,
  };
}
