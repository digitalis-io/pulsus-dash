/**
 * Fixtures of plan #63 Appendix A.4.2–A.4.3: series keyed `000000000000000<n>` by index, on the
 * grid `[0, 5000]` unless given, and the bucket fixtures H1, G2, G3 and J6.
 */
import type { Completeness } from '../data/decode';
import type { SeriesFrame } from '../data/frames';

export const N = NaN;

export const EMPTY_COMPLETENESS: Completeness = {
  truncated: false,
  warnings: [],
  infos: [],
  queryId: null,
  dataAgeMs: null,
  readCache: null,
  readCacheThroughMs: null,
};

/** The key of fixture series `n` (A.4.2). */
export function fkey(n: number): string {
  return n.toString(16).padStart(16, '0');
}

export interface Spec {
  readonly labels: Readonly<Record<string, string>>;
  readonly values: readonly number[];
}

/** Series from specs, keyed by index, on `timestamps`. */
export function fixture(
  specs: readonly Spec[],
  timestamps: readonly number[] = [0, 5000],
): SeriesFrame[] {
  return specs.map((s, i) => ({
    key: fkey(i),
    labels: s.labels,
    timestamps: new Float64Array(timestamps),
    values: new Float64Array(s.values),
  }));
}

export const le = (bound: string, values: readonly number[], other: Record<string, string> = {}) =>
  ({ labels: { ...other, le: bound }, values }) as const;

/** H1: `0.1: [1,2]`, `1: [3,5]`, `+Inf: [4,5]`. */
export const H1 = (): SeriesFrame[] =>
  fixture([le('0.1', [1, 2]), le('1', [3, 5]), le('+Inf', [4, 5])]);

/** G2: two complete groups `{job: a}` (series 0–2) and `{job: b}` (3–5). */
export const G2 = (): SeriesFrame[] =>
  fixture([
    le('0.1', [1, 1], { job: 'a' }),
    le('1', [2, 3], { job: 'a' }),
    le('+Inf', [2, 4], { job: 'a' }),
    le('0.1', [0, 1], { job: 'b' }),
    le('1', [1, 1], { job: 'b' }),
    le('+Inf', [5, 5], { job: 'b' }),
  ]);

/** G3: groups with differing bounds: a `1, 2, +Inf`; b `2, +Inf`; c `1, +Inf`. */
export const G3 = (): SeriesFrame[] =>
  fixture([
    le('1', [1, 2], { job: 'a' }),
    le('2', [3, 4], { job: 'a' }),
    le('+Inf', [6, 6], { job: 'a' }),
    le('2', [2, 2], { job: 'b' }),
    le('+Inf', [5, 7], { job: 'b' }),
    le('1', [1, 1], { job: 'c' }),
    le('+Inf', [4, 4], { job: 'c' }),
  ]);

/** J6: `{job: a}` `0.1`, `+Inf`; `{job: c}` `+Inf` only (series 2). */
export const J6 = (): SeriesFrame[] =>
  fixture([
    le('0.1', [1, 1], { job: 'a' }),
    le('+Inf', [2, 2], { job: 'a' }),
    le('+Inf', [3, 3], { job: 'c' }),
  ]);

/** A Float64Array as a plain array, so `toEqual` compares NaN as equal to NaN. */
export const arr = (a: Float64Array): number[] => Array.from(a);
