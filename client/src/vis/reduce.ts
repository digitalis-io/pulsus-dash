/** Categorical transforms (T22 §5.2). Stub until #173 Part 1. */
import type { Sort } from '../boards/options';
import type { Completeness } from '../data/decode';
import type {
  CategoryRow,
  Coverage,
  Labels,
  Mark,
  Reducer,
  SeriesFrame,
} from '../data/frames';
import type { SummaryFacts, ValueRange } from '../engine/api';
import type { Unit } from '../i18n/format';
import type { ExploreResult } from './autovis';
import type { Thresholds } from './thresholds';

export type { Sort };

export const BAR_CAP = 200;

export function barCap(_plotExtentCss: number): number {
  return BAR_CAP;
}

export function mergeDuplicates(
  series: readonly SeriesFrame[],
  _source: 'instant' | 'range',
): { series: SeriesFrame[]; duplicates: number; conflicts: number } {
  return { series: [...series], duplicates: 0, conflicts: 0 };
}

export function reduceSeries(_s: SeriesFrame, _r: Reducer): number {
  return 0;
}

export function effectiveLabel(_series: readonly SeriesFrame[], _categoryBy: string): string | null {
  return '';
}

export function markNames(
  rows: readonly { key: string; labels: Labels }[],
  _label: string | null,
  _aggregates?: readonly string[],
): string[] {
  return rows.map(() => '');
}

export interface CategoryResult {
  readonly rows: CategoryRow[];
  readonly label: string | null;
  readonly duplicates: number;
  readonly conflicts: number;
  readonly baseline: { readonly duplicates: number; readonly conflicts: number } | null;
}

export function categoryRows(
  _r: ExploreResult,
  _base: ExploreResult | null,
  _o: { reducer: Reducer; categoryBy: string; sort: Sort; thresholds: Thresholds | null },
): CategoryResult {
  return { rows: [], label: null, duplicates: 0, conflicts: 0, baseline: null };
}

export interface Capped<M extends Mark> {
  readonly drawn: M[];
  readonly kept: { readonly min: boolean; readonly max: boolean; readonly worst: number };
}

export function capMarks<M extends Mark>(_sorted: readonly M[], _cap: number): Capped<M> {
  return { drawn: [], kept: { min: false, max: false, worst: 0 } };
}

export function categoryCoverage(a: {
  all: readonly Mark[];
  capped: Capped<Mark>;
  query: Completeness;
  baseline: Completeness | null;
  outside: number;
  duplicates: number;
  conflicts: number;
}): Coverage {
  return {
    total: 0,
    drawn: 0,
    keptMin: false,
    keptMax: false,
    keptWorst: 0,
    omittedWorst: 0,
    worstState: null,
    outside: 0,
    duplicates: 0,
    conflicts: 0,
    query: a.query,
    baseline: a.baseline,
  };
}

export function coverageText(_c: Coverage, _timeZone?: string): string {
  return '';
}

export function tooSmallText(_all: readonly Mark[], _unit: Unit): string {
  return '';
}

export function outsideCount(_drawn: readonly Mark[], _range: ValueRange | null): number {
  return -1;
}

export function resolveBounds(
  _min: number | undefined,
  _max: number | undefined,
  auto: ValueRange,
): ValueRange {
  return auto;
}

export type FilterPair =
  | { readonly key: string; readonly value: string }
  | { readonly reason: 'noLabel' }
  | { readonly reason: 'missing'; readonly label: string };

export function filterPair(_m: Mark, _label: string | null): FilterPair {
  return { reason: 'noLabel' };
}

export function filterBlockText(_p: Exclude<FilterPair, { key: string }>): string {
  return '';
}

export function deltaText(_v: number, _b: number | null): string | null {
  return null;
}

export type TableKind = 'barchart';

export interface PanelRows {
  readonly columns: readonly string[];
  readonly rows: readonly {
    readonly mark: Mark;
    readonly drawn: boolean;
    readonly shownAs: string;
    readonly cells: readonly string[];
  }[];
}

export function panelRows(
  _kind: TableKind,
  _all: readonly Mark[],
  _drawn: readonly CategoryRow[],
  _unit: Unit,
): PanelRows {
  return { columns: [], rows: [] };
}

export function panelCsv(_t: PanelRows): string {
  return '';
}

export function csvFileName(_title: string): string {
  return '';
}

export function summaryFacts(
  _kind: TableKind,
  title: string,
  _r: ExploreResult,
  _all: readonly Mark[],
  _unit: Unit,
  _baseline: Completeness | null,
): SummaryFacts {
  return { subject: title, current: null, change: null, extent: null, baselineRatio: null };
}
