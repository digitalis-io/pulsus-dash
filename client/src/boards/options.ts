/**
 * Panel options (board spec v3; T22 §6.1, plan #173 Part 1 §3.3 and §3.6; the widget keys by board
 * spec v5, plan #198 Part 1, T24 §5.1): the keys each kind allows, their types, members and values,
 * the kinds not drawn yet, a kind change, and the bar chart's defaults. The Go tables (`server/internal/spec/shape.go`, `validate.go`) are the same; both
 * suites compare them with `api/fixtures/board-spec/option-keys.json`.
 */
import type { DataPanelSpec, DataVisKind, PanelVisKind, VisOptions } from '../api/types';
import type { Reducer } from '../data/frames';

export type OptionKey = keyof VisOptions;
export type Sort = 'valueDesc' | 'valueAsc' | 'label' | 'none';

/** Every option key, in the order the rules pass checks them (§3.3 row order). */
export const OPTION_ORDER: readonly OptionKey[] = Object.freeze([
  'reducer',
  'baselineOffset',
  'categoryBy',
  'sort',
  'orientation',
  'valueLabels',
  'min',
  'max',
  'donut',
  'labels',
  'parts',
  'layout',
  'colourMode',
  'textMode',
  'graphMode',
  'mode',
  'content',
  'language',
  'zones',
  'hourCycle',
  'seconds',
  'date',
  'countdown',
] as const);

/** The JSON type of each key (the shape pass). */
export const OPTION_TYPES: Readonly<
  Record<OptionKey, 'string' | 'bool' | 'number' | 'array' | 'object'>
> = Object.freeze({
  reducer: 'string',
  baselineOffset: 'string',
  categoryBy: 'string',
  sort: 'string',
  orientation: 'string',
  valueLabels: 'bool',
  min: 'number',
  max: 'number',
  donut: 'bool',
  labels: 'string',
  parts: 'bool',
  layout: 'string',
  colourMode: 'string',
  textMode: 'string',
  graphMode: 'string',
  mode: 'string',
  content: 'string',
  language: 'string',
  zones: 'array',
  hourCycle: 'string',
  seconds: 'bool',
  date: 'bool',
  countdown: 'object',
  query: 'string',
  tag: 'string',
  limit: 'number',
});

/**
 * The members of the object keys (zones' items, countdown), in order: each a required string (the
 * Go `zoneShape`, `countdownShape`).
 */
export const OPTION_MEMBERS = Object.freeze({
  zones: ['tz', 'label'],
  countdown: ['to', 'label', 'after'],
} as const satisfies Partial<Record<OptionKey, readonly string[]>>);

/** The keys each kind allows, in `OPTION_ORDER`; any other key is `board.json.unknownKey`. */
export const OPTION_KEYS: Readonly<Record<PanelVisKind, readonly OptionKey[]>> = Object.freeze({
  auto: ['reducer', 'parts'],
  line: [],
  bars: [],
  heatmap: [],
  stat: [
    'reducer',
    'baselineOffset',
    'sort',
    'orientation',
    'min',
    'max',
    'layout',
    'colourMode',
    'textMode',
    'graphMode',
  ],
  logs: [],
  barchart: [
    'reducer',
    'baselineOffset',
    'categoryBy',
    'sort',
    'orientation',
    'valueLabels',
    'min',
    'max',
  ],
  pie: ['reducer', 'categoryBy', 'sort', 'donut', 'labels', 'parts'],
  text: ['mode', 'content', 'language'],
  clock: ['zones', 'hourCycle', 'seconds', 'date', 'countdown'],
  boardList: [],
});

/** The allowed values of the enum keys; `orientation` also allows `auto` on stat. */
export const OPTION_VALUES = Object.freeze({
  reducer: ['last', 'first', 'mean', 'min', 'max', 'sum', 'count'],
  baselineOffset: ['1h', '1d', '7d', '28d'],
  sort: ['valueDesc', 'valueAsc', 'label', 'none'],
  orientation: ['horizontal', 'vertical'],
  statOrientation: ['auto', 'horizontal', 'vertical'],
  labels: ['percent', 'value', 'name', 'none'],
  layout: ['single', 'grid'],
  colourMode: ['value', 'background', 'none'],
  textMode: ['auto', 'value', 'valueAndName', 'name'],
  graphMode: ['sparkline', 'none'],
  mode: ['markdown', 'code'],
  language: ['plaintext', 'json', 'yaml', 'sql', 'promql', 'logql', 'go', 'shell'],
  hourCycle: ['auto', 'h12', 'h23'],
  after: ['countUp', 'hide'],
} as const satisfies Record<string, readonly string[]>);

/** `|min|` and `|max|` are at most this. */
export const MAX_OPTION_ABS = 1e15;

/**
 * The kinds a stored spec may name that this version does not draw yet: such a panel sends no
 * query and shows `panel.kindUnavailable`. Shrinks in Part 2 (barchart) and I3 (pie).
 */
export const PENDING_KINDS: ReadonlySet<PanelVisKind> = new Set<PanelVisKind>(['barchart', 'pie']);

export interface BarchartOptions {
  readonly reducer: Reducer;
  readonly baselineOffset: NonNullable<VisOptions['baselineOffset']> | null;
  readonly categoryBy: string;
  readonly sort: Sort;
  readonly orientation: 'horizontal' | 'vertical';
  readonly valueLabels: boolean;
  readonly min: number | undefined;
  readonly max: number | undefined;
}

/** The options `kind` allows, of `o`; undefined when none is left. */
export function keepOptions(kind: PanelVisKind, o: VisOptions | undefined): VisOptions | undefined {
  if (o === undefined) return undefined;
  const allowed: readonly string[] = OPTION_KEYS[kind];
  const kept = Object.fromEntries(
    Object.entries(o).filter(([k]) => allowed.includes(k)),
  ) as VisOptions;
  return Object.keys(kept).length === 0 ? undefined : kept;
}

/**
 * `vis` with `kind`: thresholds and legend kept, options reduced to the keys the new kind allows
 * (`keepOptions`), and the `options` member omitted when none is left.
 */
export function withKind(vis: DataPanelSpec['vis'], kind: DataVisKind): DataPanelSpec['vis'] {
  const { options, ...rest } = vis;
  const kept = keepOptions(kind, options);
  return kept === undefined ? { ...rest, kind } : { ...rest, kind, options: kept };
}

/** Whether `v` is a chart sort (stub). */
export function isChartSort(v: unknown): v is Sort {
  return typeof v === 'string';
}

/**
 * A bar chart's options with the T22 §6.1 defaults: `last`, no baseline, `''` (the effective
 * label), `valueDesc`, `horizontal` and value labels on; min and max absent (auto).
 */
export function barchartOptions(o: VisOptions | undefined): BarchartOptions {
  return {
    reducer: o?.reducer ?? 'last',
    baselineOffset: o?.baselineOffset ?? null,
    categoryBy: o?.categoryBy ?? '',
    sort: isChartSort(o?.sort) ? o.sort : 'valueDesc',
    orientation: o?.orientation === 'vertical' ? 'vertical' : 'horizontal',
    valueLabels: o?.valueLabels ?? true,
    min: o?.min,
    max: o?.max,
  };
}
