/**
 * Widget panels (plan #198 Part 1 §3.3; T24-002, T24-003, T24 §5.1; the board list by plan #216
 * Part 1): the widget kinds, the kinds
 * not drawn yet, the guards that split a panel into a data panel (with a query) and a widget
 * (without one), and the text and clock options with their defaults.
 */
import { OPTION_VALUES } from '../boards/options';
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
export const WIDGET_KINDS: ReadonlySet<PanelVisKind> = new Set<PanelVisKind>([
  'text',
  'clock',
  'boardList',
]);

/**
 * The widget kinds this version does not draw yet: such a panel shows `widget.kindUnavailable`.
 * The clock until A2; Text draws from #198 Part 3a, the board list from #216 Part 2a.
 */
export const PENDING_WIDGETS: ReadonlySet<WidgetKind> = new Set<WidgetKind>(['clock']);

/**
 * The widget kinds with a table view (T24-026; plan #216 Part 2a): the Panel menu has "Show as
 * table" / "Show list", and Shift+T flips it.
 */
export const TABLE_WIDGETS: ReadonlySet<WidgetKind> = new Set<WidgetKind>(['boardList']);

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

/** A text widget's default mode. */
export const DEFAULT_TEXT_MODE = 'markdown';

/**
 * Whether `v` is a text mode (`OPTION_VALUES.mode`): the stored `mode` may hold a board list's
 * value, which the validator refuses on a text; the reader falls back to the default.
 */
export function isTextMode(v: unknown): v is TextOptions['mode'] {
  return (OPTION_VALUES.mode as readonly unknown[]).includes(v);
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
