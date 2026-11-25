/** Panel options (board spec v3, T22 §6.1). Stub until #173 Part 1. */
import type { PanelSpec, PanelVisKind, VisOptions } from '../api/types';
import type { Reducer } from '../data/frames';

export type OptionKey = keyof VisOptions;
export type Sort = 'valueDesc' | 'valueAsc' | 'label' | 'none';

export const OPTION_ORDER: readonly OptionKey[] = [];
export const OPTION_TYPES: Readonly<Record<OptionKey, 'string' | 'bool' | 'number'>> = {
  reducer: 'string',
  baselineOffset: 'string',
  categoryBy: 'string',
  sort: 'string',
  orientation: 'string',
  valueLabels: 'string',
  min: 'string',
  max: 'string',
  donut: 'string',
  labels: 'string',
  parts: 'string',
  layout: 'string',
  colourMode: 'string',
  textMode: 'string',
  graphMode: 'string',
};
export const OPTION_KEYS: Readonly<Record<PanelVisKind, readonly OptionKey[]>> = {
  auto: [],
  line: [],
  bars: [],
  heatmap: [],
  stat: [],
  logs: [],
  barchart: [],
  pie: [],
};
export const PENDING_KINDS: ReadonlySet<PanelVisKind> = new Set();

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

export function keepOptions(_kind: PanelVisKind, o: VisOptions | undefined): VisOptions | undefined {
  return o;
}

export function withKind(vis: PanelSpec['vis'], kind: PanelVisKind): PanelSpec['vis'] {
  return { ...vis, kind };
}

export function barchartOptions(_o: VisOptions | undefined): BarchartOptions {
  return {
    reducer: 'first',
    baselineOffset: null,
    categoryBy: '',
    sort: 'none',
    orientation: 'vertical',
    valueLabels: false,
    min: undefined,
    max: undefined,
  };
}
