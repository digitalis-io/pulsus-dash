/** Histogram transforms (T21-012 to T21-016). Stubs: the tests come first. */
import type { SummaryFacts } from '../../engine/api';
import type { Completeness } from '../../data/decode';
import type {
  HistogramCoverage,
  HistogramFrame,
  HistogramGroup,
  SeriesFrame,
  SourceGroup,
} from '../../data/frames';
import type { Unit } from '../../i18n/format';
import type { Slicer } from './slice';

export const MAX_HIST_SAMPLES = 2_000_000;
export const MAX_BINS = 200;
export const DRAWN_GROUPS = 7;
export const DOMAIN_LO = 1e-290;
export const DOMAIN_HI = 1e290;

export interface HistogramOptions {
  readonly binMode: 'auto' | 'count' | 'width';
  readonly binCount: number;
  readonly binWidth: number | null;
  readonly scale: 'linear' | 'log';
  readonly groupBy: string | null;
  readonly groupMode: 'stack' | 'overlay';
  readonly cumulative: 'none' | 'cdf' | 'ecdf';
  readonly unit: Unit;
}

export type HistogramResult =
  | { readonly kind: 'frame'; readonly frame: HistogramFrame }
  | { readonly kind: 'empty'; readonly coverage: HistogramCoverage }
  | {
      readonly kind: 'noneShown';
      readonly coverage: HistogramCoverage;
      readonly sourceGroups: readonly SourceGroup[];
    }
  | { readonly kind: 'tooMany'; readonly samples: number; readonly query: Completeness }
  | { readonly kind: 'buckets'; readonly leSeries: number; readonly query: Completeness };

export interface BinLayout {
  readonly width: number;
  readonly height: number;
  readonly edgePx: Float64Array;
  readonly countMax: number;
  readonly mode: 'stack' | 'overlay';
  readonly top: Float64Array;
  readonly bottom: Float64Array;
}

export type MeterPart =
  | { readonly kind: 'query' | 'duplicates' | 'widened' | 'adjusted'; readonly text: string }
  | { readonly kind: 'nonPositive' | 'infinite' | 'outOfRange'; readonly text: string };

const ZERO = (q: Completeness): HistogramCoverage => ({
  query: q,
  received: 0,
  drawable: 0,
  nonPositive: 0,
  infinite: 0,
  outOfRange: 0,
  duplicates: 0,
  conflicts: 0,
  widenedTo: null,
  adjusted: null,
});

export function histogram(
  input: readonly SeriesFrame[],
  source: 'instant' | 'range',
  o: HistogramOptions,
  q: Completeness,
): HistogramResult {
  void [input, source, o];
  return { kind: 'empty', coverage: ZERO(q) };
}
export function binEdges(
  sortedValues: Float64Array,
  o: HistogramOptions,
): { edges: Float64Array; widenedTo: number | null; adjusted: number | null } {
  void [sortedValues, o];
  return { edges: new Float64Array([0, 1]), widenedTo: null, adjusted: null };
}
export function scaleOf(min: number, max: number): number {
  void [min, max];
  return 0;
}
export function binIndex(edges: Float64Array, x: number): number {
  void [edges, x];
  return -1;
}
export function displayCollapsed(edges: Float64Array, unit: Unit): boolean {
  void [edges, unit];
  return false;
}
export function binLabels(edges: Float64Array, unit: Unit): string[] {
  void [edges, unit];
  return [];
}
export function binRangeText(f: HistogramFrame, labels: readonly string[], i: number): string {
  void [f, labels, i];
  return '';
}
export function groupKey(label: string, value: string | null): string {
  void [label, value];
  return '';
}
export function cdf(f: HistogramFrame, group: number | null): Float64Array {
  void [f, group];
  return new Float64Array(0);
}
export function ecdfAt(f: HistogramFrame, sourceGroups: readonly number[], x: number): number {
  void [f, sourceGroups, x];
  return NaN;
}
export function edgePx(edges: Float64Array, scale: 'linear' | 'log', width: number): Float64Array {
  void [edges, scale, width];
  return new Float64Array(0);
}
export function binLayout(
  f: HistogramFrame,
  scale: 'linear' | 'log',
  mode: 'stack' | 'overlay',
  width: number,
  height: number,
): BinLayout {
  void [f, scale];
  const z = new Float64Array(0);
  return { width, height, edgePx: z, countMax: 1, mode, top: z, bottom: z };
}
export function binAtPx(px: Float64Array, p: number): number {
  void [px, p];
  return -2;
}
export function hitTestBin(
  f: HistogramFrame,
  l: BinLayout,
  xCss: number,
  yCss: number,
): { index: number; group: number } | null {
  void [f, l, xCss, yCss];
  return { index: -2, group: -2 };
}
export function brushBins(
  f: HistogramFrame,
  l: BinLayout,
  p0: number,
  p1: number,
): { first: number; last: number; from: number; to: number } | null {
  void [f, l, p0, p1];
  return { first: -2, last: -2, from: NaN, to: NaN };
}
export function selectedCounts(
  f: HistogramFrame,
  keys: ReadonlySet<string>,
  s: Slicer,
): Promise<Float64Array | null> {
  void [f, keys, s];
  return Promise.resolve(new Float64Array(0));
}
export function binSeries(
  f: HistogramFrame,
  groups: readonly number[],
  from: number,
  to: number,
  s: Slicer,
): Promise<string[]> {
  void [f, groups, from, to, s];
  return Promise.resolve([]);
}
export function histogramMeterParts(c: HistogramCoverage, unit: Unit): MeterPart[] {
  void [c, unit];
  return [];
}
export function histogramCoverageText(c: HistogramCoverage, unit: Unit): string {
  void [c, unit];
  return '';
}
export function exclusionLines(
  sourceGroups: readonly SourceGroup[],
  groups: readonly HistogramGroup[],
): string[] {
  void [sourceGroups, groups];
  return [];
}
export function noneShownText(c: HistogramCoverage, unit: Unit): string {
  void [c, unit];
  return '';
}
export function summaryFacts(title: string, f: HistogramFrame, unit: Unit): SummaryFacts {
  void [title, f, unit];
  return { subject: '', current: null, change: null, extent: null, baselineRatio: null };
}
