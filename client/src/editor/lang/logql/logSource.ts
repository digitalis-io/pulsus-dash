/**
 * The completion lookups of LogQL (plan #66 Part A §3.6; T09-007, T09-014): label names and
 * values through the BFF's `/logs/labels` and `/logs/label/{name}/values` (`Api.logLabels`,
 * `Api.logLabelValues`) and the suggest cache, keyed by tenant, language and 15-min window bucket,
 * over the window snapped to whole minutes with limit 1 000. `query` is the selector exactly as
 * the caret context wrote it, sent only when there is one. The caller's signal is its interest in
 * the shared request (`SuggestCache.get`). A source never rejects: any failure (a refused reserved
 * scope included), abort or ended generation resolves `[]`, with nothing logged or shown (T09 §9).
 */
import { suggestCache, windowBucket, type SuggestKind } from '../../suggestCache';
import { minuteWindow } from '../lookupWindow';
import type { LanguageDeps, LogSource } from '../types';

/** The BFF's default. */
export const LOG_LOOKUP_LIMIT = 1_000;

const NONE: readonly string[] = [];

/**
 * `cache.retainTenant(tenant)` once: the source keeps that token, so after another tenant is
 * retained or the cache is cleared it sends nothing. A tenant change needs a new source.
 */
export function createLogSource(d: LanguageDeps): LogSource {
  const cache = d.cache ?? suggestCache;
  const tenant = d.tenant;
  const g = cache.retainTenant(tenant);

  function lookup(
    kind: SuggestKind,
    label: string | null,
    selector: string | null,
    load: (
      req: { fromMs: number; toMs: number; query?: string; limit: number },
      signal: AbortSignal,
    ) => Promise<readonly string[]>,
    signal: AbortSignal | undefined,
  ): Promise<readonly string[]> {
    const w = d.window();
    const req = {
      ...minuteWindow(w),
      ...(selector === null ? {} : { query: selector }),
      limit: LOG_LOOKUP_LIMIT,
    };
    const parts = {
      tenant,
      lang: 'logql' as const,
      kind,
      label,
      selector,
      bucket: windowBucket(w.toMs),
    };
    return cache.get(g, parts, (s) => load(req, s), signal).catch(() => NONE);
  }

  return {
    labelNames: (selector, signal) =>
      lookup(
        'labels',
        null,
        selector,
        (req, s) => d.api.logLabels(tenant, req, s).then((r) => r.values),
        signal,
      ),
    labelValues: (name, selector, signal) =>
      lookup(
        'values',
        name,
        selector,
        (req, s) => d.api.logLabelValues(tenant, name, req, s).then((r) => r.values),
        signal,
      ),
  };
}
