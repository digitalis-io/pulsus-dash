/**
 * Metric kinds and the suffix rules (plan #112 §3.7): a metric's type from its own metadata entry,
 * else from its base name without `_bucket`, `_count`, `_sum` or `_total`. The metric picker shows
 * it; the StubApi planner mirror rates by it. Nothing here decides the text sent: the server's
 * planner does (ADR-0021).
 */
export type MetricKind = 'counter' | 'gauge' | 'histogram' | 'summary' | 'unknown';

const KINDS: readonly MetricKind[] = ['counter', 'gauge', 'histogram', 'summary', 'unknown'];
const SUFFIXES = ['_bucket', '_count', '_sum', '_total'] as const;

/** Undefined → null; a type that is not one of the kinds → `'unknown'`. */
export function kindOfType(type: string | undefined): MetricKind | null {
  if (type === undefined) return null;
  return KINDS.find((k) => k === type) ?? 'unknown';
}

/**
 * The kind of `name`, given `own(n)` (the kind of `n`'s own metadata entry, or null): its own kind;
 * else that of its base name without one of the suffixes, where a `_count` or `_sum` of a histogram
 * or summary is a counter; a name with neither is unknown.
 */
export function metricKind(name: string, own: (name: string) => MetricKind | null): MetricKind {
  const k = own(name);
  if (k !== null) return k;
  for (const suffix of SUFFIXES) {
    if (!name.endsWith(suffix)) continue;
    const base = own(name.slice(0, -suffix.length));
    if (base === null) return 'unknown';
    if ((suffix === '_count' || suffix === '_sum') && (base === 'histogram' || base === 'summary'))
      return 'counter';
    return base;
  }
  return 'unknown';
}
