/**
 * The completion lookups of PromQL (plan #63 Part B §3.3; T09-007, T09-014, SRF-027): every lookup
 * goes through the BFF's `/prom/*` routes (`Api.prom*`) and the suggest cache, keyed by tenant and
 * 15-min window bucket. Names, label names and label values are asked over the window snapped to
 * whole minutes (start floored, end ceiled, one minute when they meet), series over whole seconds,
 * the request shapes PulsusDB is tested with. A source never rejects: any failure, abort or
 * ended generation resolves `[]` (`{}` for metadata), with nothing logged or shown (T09 §9).
 */
import { promMetadataQuery } from '../../../explore/promMetadata';
import { suggestCache, windowBucket, type SuggestKind } from '../../suggestCache';
import { minuteWindow, secondWindow, type LookupWindow } from '../lookupWindow';
import type { LanguageDeps, PromSource } from '../types';

/** All names: the prefix is filtered locally (T09-007). */
export const PROM_NAMES_LIMIT = 10_000;
/** The BFF's default. */
export const PROM_LOOKUP_LIMIT = 1_000;

export type PromSourceDeps = LanguageDeps;

type Window = LookupWindow;

const matchOf = (m: string | null) => (m === null ? {} : { match: [m] });

/**
 * `cache.retainTenant(tenant)` once: the source keeps that token, so after another tenant is
 * retained or the cache is cleared it sends nothing. A tenant change needs a new source.
 */
export function createPromSource(d: PromSourceDeps): PromSource {
  const cache = d.cache ?? suggestCache;
  const tenant = d.tenant;
  const g = cache.retainTenant(tenant);

  function lookup<T>(
    kind: SuggestKind,
    label: string | null,
    selector: string | null,
    load: (w: Window, signal: AbortSignal) => Promise<T>,
    empty: T,
  ): Promise<T> {
    const w = d.window();
    const parts = {
      tenant,
      lang: 'promql' as const,
      kind,
      label,
      selector,
      bucket: windowBucket(w.toMs),
    };
    return cache.get(g, parts, (signal) => load(w, signal)).catch(() => empty);
  }
  const minutes = minuteWindow;
  const seconds = secondWindow;
  const none: readonly string[] = [];

  return {
    metricNames: () =>
      lookup(
        'names',
        null,
        null,
        (w, signal) =>
          d.api
            .promLabelValues(tenant, '__name__', { ...minutes(w), limit: PROM_NAMES_LIMIT }, signal)
            .then((r) => r.values),
        none,
      ),
    labelNames: (m) =>
      lookup(
        'labels',
        null,
        m,
        (w, signal) =>
          d.api
            .promLabels(tenant, { ...minutes(w), ...matchOf(m), limit: PROM_LOOKUP_LIMIT }, signal)
            .then((r) => r.values),
        none,
      ),
    labelValues: (name, m) =>
      lookup(
        'values',
        name,
        m,
        (w, signal) =>
          d.api
            .promLabelValues(
              tenant,
              name,
              { ...minutes(w), ...matchOf(m), limit: PROM_LOOKUP_LIMIT },
              signal,
            )
            .then((r) => r.values),
        none,
      ),
    series: (m) => {
      if (m === '') return Promise.resolve([]);
      return lookup(
        'series',
        null,
        m,
        (w, signal) =>
          d.api
            .promSeries(tenant, { ...seconds(w), match: [m], limit: PROM_LOOKUP_LIMIT }, signal)
            .then((r) => r.series.map((s) => s.labels)),
        [],
      );
    },
    // Not cached here (D-LRU): one TanStack query per tenant, shared with the page. Tracked, so a
    // tenant switch or clear() ends it at once; the query itself keeps settling under its own key.
    metadata: () =>
      cache
        .track(g, () => d.queryClient.query(promMetadataQuery(d.api, tenant)))
        .then((r) =>
          Object.fromEntries(
            Object.entries(r.metrics).map(([name, list]) => [
              name,
              list.map(({ type, help }) => ({ type, help })),
            ]),
          ),
        )
        .catch(() => ({})),
  };
}
