/**
 * Panel options (board spec v3; T22 §6.1, plan #173 Part 1 §3.3 and §3.6): the keys each kind
 * allows, their types and values, the kinds not drawn yet, a kind change, and the bar chart's
 * defaults. The Go tables (`server/internal/spec/shape.go`, `validate.go`) are the same; both
 * suites compare them with `api/fixtures/board-spec/option-keys.json`.
 */
import type { PanelSpec, PanelVisKind, VisOptions } from '../api/types';
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
] as const);

/** The JSON type of each key (the shape pass). */
export const OPTION_TYPES: Readonly<Record<OptionKey, 'string' | 'bool' | 'number'>> =
  Object.freeze({
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
  });

/** Stub until the widgets version (plan #198 Part 1 §3.3). */
export const OPTION_MEMBERS = Object.freeze({});

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
export function withKind(vis: PanelSpec['vis'], kind: PanelVisKind): PanelSpec['vis'] {
  const { options, ...rest } = vis;
  const kept = keepOptions(kind, options);
  return kept === undefined ? { ...rest, kind } : { ...rest, kind, options: kept };
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
    sort: o?.sort ?? 'valueDesc',
    orientation: o?.orientation === 'vertical' ? 'vertical' : 'horizontal',
    valueLabels: o?.valueLabels ?? true,
    min: o?.min,
    max: o?.max,
  };
}
