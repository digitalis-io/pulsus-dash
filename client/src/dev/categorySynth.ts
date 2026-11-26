/**
 * Categorical data builders (T22 §10.2; plan #173 Part 1 §5, Part 2 §4.5): `byVersion`, `many`,
 * `threeKeys` and the `barchart-dupes` series, as explore results or marks, for the gallery and
 * the tests (`test/categoryFixtures.ts` re-exports them). Keys are `000000000000<n>` in hex.
 */
import type { Completeness } from '../data/decode';
import type { CategoryRow, Labels, SeriesFrame } from '../data/frames';
import type { ExploreResult } from '../vis/autovis';

/** The key of row `n`: 16 hex digits. */
export function fkey(n: number): string {
  return n.toString(16).padStart(16, '0');
}

/** A complete run: not truncated, no warnings. */
export const COMPLETE: Completeness = Object.freeze({
  truncated: false,
  warnings: [],
  infos: [],
  queryId: null,
  dataAgeMs: null,
  readCache: null,
  readCacheThroughMs: null,
});

/** The instant of the instant fixtures, and the range grid t0…t3. */
export const AT_MS = 1_000_000;
export const T = [0, 60_000, 120_000, 180_000] as const;

export interface InstantSpec {
  readonly key?: string;
  readonly labels: Labels;
  readonly value: number;
  readonly atMs?: number;
}

export interface RangeSpec {
  readonly key?: string;
  readonly labels: Labels;
  readonly values: readonly number[];
  readonly timestamps?: readonly number[];
}

/** An instant vector: one sample per series, keyed by index (1-based) unless given. */
export function instant(specs: readonly InstantSpec[], q: Completeness = COMPLETE): ExploreResult {
  const series: SeriesFrame[] = specs.map((s, i) => ({
    key: s.key ?? fkey(i + 1),
    labels: s.labels,
    timestamps: new Float64Array([s.atMs ?? AT_MS]),
    values: new Float64Array([s.value]),
  }));
  return { kind: 'series', source: 'instant', series, stepMs: null, completeness: q };
}

/** A range result: on `T` unless given, keyed by index (1-based) unless given. */
export function range(specs: readonly RangeSpec[], q: Completeness = COMPLETE): ExploreResult {
  const series: SeriesFrame[] = specs.map((s, i) => ({
    key: s.key ?? fkey(i + 1),
    labels: s.labels,
    timestamps: new Float64Array(s.timestamps ?? T.slice(0, s.values.length)),
    values: new Float64Array(s.values),
  }));
  return { kind: 'series', source: 'range', series, stepMs: 60_000, completeness: q };
}

/** `byVersion`: `{version=2.29…2.33}` = 40, 7, 120, 3, 15 (T22 §10.2). */
export const BY_VERSION: readonly InstantSpec[] = [
  { labels: { version: '2.29' }, value: 40 },
  { labels: { version: '2.30' }, value: 7 },
  { labels: { version: '2.31' }, value: 120 },
  { labels: { version: '2.32' }, value: 3 },
  { labels: { version: '2.33' }, value: 15 },
];

export const byVersion = (): ExploreResult => instant(BY_VERSION);

/** `threeKeys`: `{a, b, c}` = {1,x,p}, {2,y,p}, {3,x,q}, {4,y,q} = 4, 3, 2, 1 (three keys vary). */
export const threeKeys = (): ExploreResult =>
  instant([
    { labels: { a: '1', b: 'x', c: 'p' }, value: 4 },
    { labels: { a: '2', b: 'y', c: 'p' }, value: 3 },
    { labels: { a: '3', b: 'x', c: 'q' }, value: 2 },
    { labels: { a: '4', b: 'y', c: 'q' }, value: 1 },
  ]);

/** `barchart-dupes`: {2.31, eu} 50, {2.31, us} 70, {2.30, eu} 20. */
export const dupes = (): ExploreResult =>
  instant([
    { labels: { version: '2.31', region: 'eu' }, value: 50 },
    { labels: { version: '2.31', region: 'us' }, value: 70 },
    { labels: { version: '2.30', region: 'eu' }, value: 20 },
  ]);

/**
 * `many`: 250 rows with values 250…1, in valueDesc order, labels `{n: String(v)}` and named so;
 * states set directly: only the value-10 row is `failing`, every other row `ok`.
 */
export function many(): CategoryRow[] {
  const rows: CategoryRow[] = [];
  for (let v = 250; v >= 1; v--) {
    rows.push({
      key: fkey(v),
      labels: { n: String(v) },
      name: String(v),
      value: v,
      state: v === 10 ? 'failing' : 'ok',
      baseline: null,
      anomaly: null,
      members: null,
    });
  }
  return rows;
}

/** A plain row (no state, baseline or members). */
export function row(key: string, name: string, value: number, labels: Labels = {}): CategoryRow {
  return { key, labels, name, value, state: null, baseline: null, anomaly: null, members: null };
}
