/**
 * Metric kinds and the suffix rules (plan #112 §3.7): a metric's type from its own metadata entry,
 * else from its base name without `_bucket`, `_count`, `_sum` or `_total`. The metric picker shows
 * it; the StubApi planner mirror rates by it. Nothing here decides the text sent: the server's
 * planner does (ADR-0021).
 */
export type MetricKind = 'counter' | 'gauge' | 'histogram' | 'summary' | 'unknown';

/** Undefined → null; a type that is not one of the kinds → `'unknown'`. */
export function kindOfType(_type: string | undefined): MetricKind | null {
  throw new Error('not implemented');
}

/** The kind of `name`, given `own(n)`: the kind of `n`'s own metadata entry, or null. */
export function metricKind(_name: string, _own: (name: string) => MetricKind | null): MetricKind {
  throw new Error('not implemented');
}
