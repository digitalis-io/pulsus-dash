/**
 * Panel options (board spec v3; T22 §6.1, plan #173 Part 1 §3.3 and §3.6; the widget keys by board
 * spec v5, plan #198 Part 1, T24 §5.1; the board list keys by v6, plan #216 Part 1, T24 §5.5): the
 * keys each kind allows, their types, members and values, the kinds not drawn yet, a kind change
 * (valid values only, #173 Part 3a), and the bar chart's defaults. The Go tables
 * (`server/internal/spec/shape.go`, `validate.go`) are the same; both
 * suites compare them with `api/fixtures/board-spec/option-keys.json`.
 */
import type { DataPanelSpec, DataVisKind, PanelVisKind, VisOptions } from '../api/types';
import type { Reducer } from '../data/frames';
// A cycle with `spec.ts`, safe: neither module reads the other's bindings while it loads.
import { optionValueValid } from './spec';

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
  'query',
  'tag',
  'limit',
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
  boardList: ['sort', 'mode', 'query', 'tag', 'limit'],
});

/**
 * The allowed values of the enum keys; `orientation` also allows `auto` on stat. `sort` and `mode`
 * are shared: a board list takes `boardListSort` and `boardListMode` instead (the Go
 * `boardListSorts`, `boardListModes`).
 */
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
  boardListMode: ['starred', 'recent', 'search', 'tag'],
  boardListSort: ['default', 'incidents'],
} as const satisfies Record<string, readonly string[]>);

/** `|min|` and `|max|` are at most this. */
export const MAX_OPTION_ABS = 1e15;

/** A board list's search text is at most this many characters (the Go `maxBoardQueryRunes`). */
export const MAX_BOARD_QUERY = 100;
/** A board list shows this many rows at a time, `min` to `max` (the Go `minBoardLimit`, `maxBoardLimit`). */
export const BOARD_LIMIT = Object.freeze({ min: 1, max: 50 } as const);

/**
 * The kinds a stored spec may name that this version does not draw yet: such a panel sends no
 * query and shows `panel.kindUnavailable`. The bar chart left it in #173 Part 3b; pie leaves in I3.
 */
export const PENDING_KINDS: ReadonlySet<PanelVisKind> = new Set<PanelVisKind>(['pie']);

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

export { optionValueValid };

/**
 * The options of `o` that `kind` allows with a valid value (`optionValueValid`, T22 §6.1, plan
 * #173 Part 3a §3.9); then `max` is dropped when min ≥ max, and `textMode` when it is `value` with
 * the `grid` layout. Undefined when none is left.
 */
export function keepOptions(kind: PanelVisKind, o: VisOptions | undefined): VisOptions | undefined {
  if (o === undefined) return undefined;
  const kept: Record<string, unknown> = Object.fromEntries(
    Object.entries(o).filter(([k, v]) => optionValueValid(kind, k as OptionKey, v)),
  );
  const { min, max } = kept as VisOptions;
  if (min !== undefined && max !== undefined && min >= max) delete kept['max'];
  if (kept['textMode'] === 'value' && kept['layout'] === 'grid') delete kept['textMode'];
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

/**
 * Whether `v` is a chart's sort (`OPTION_VALUES.sort`): the stored `sort` may hold a board list's
 * value, which the validator refuses on a chart; a reader falls back to its default.
 */
export function isChartSort(v: unknown): v is Sort {
  return (OPTION_VALUES.sort as readonly unknown[]).includes(v);
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
