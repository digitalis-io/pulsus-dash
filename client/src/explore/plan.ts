/**
 * The Explore run planner (plan #63 §3.3, SRF-030, VIZ-065): turns the editor text, its shape and
 * the metric metadata into the request the page sends. A bare counter selector is sent as
 * `rate(<sel>[w])` and a bare histogram bucket selector as `sum by (le) (rate(<sel>[w]))` behind
 * the rate chip, `w = rateWindowMs(step)`; a scalar- or string-typed query is an
 * instant query. The size limit applies to the text sent, in UTF-8 bytes (the BFF's limit, #62).
 * PulsusDB validates the query (ADR-0015); nothing here parses PromQL.
 */
import type { QueryShape } from '../editor/lang/types';

export type MetricKind = 'counter' | 'gauge' | 'histogram' | 'summary' | 'unknown';

/** Metric metadata by name, as `promMetadata` returns it (only `type` is read). */
export type MetricTypes = Readonly<Record<string, readonly { readonly type: string }[]>>;

export interface RunPlan {
  readonly kind: 'range' | 'instant';
  /** The text sent. */
  readonly query: string;
  /** `utf8Length(query)`. */
  readonly bytes: number;
  /** `bytes > MAX_QUERY_BYTES`: nothing is sent. */
  readonly tooLong: boolean;
  /** The rate chip is shown. */
  readonly rateCandidate: boolean;
  readonly rateApplied: boolean;
  /** Auto-vis rule 5 may apply. */
  readonly histogram: boolean;
  /** `query[sentStart, sentStart + (sourceEnd − sourceStart))` is `text[sourceStart, sourceEnd)`. */
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly sentStart: number;
}

/** The BFF's `checkQuery` limit in bytes (#62). */
export const MAX_QUERY_BYTES = 65_536;

const KINDS: readonly MetricKind[] = ['counter', 'gauge', 'histogram', 'summary', 'unknown'];
const SUFFIXES = ['_bucket', '_count', '_sum', '_total'] as const;

function kindOf(type: string | undefined): MetricKind | null {
  if (type === undefined) return null;
  return KINDS.find((k) => k === type) ?? 'unknown';
}

/**
 * The first entry's `type` of `meta[name]`; else that of the base name without one of `_bucket`,
 * `_count`, `_sum`, `_total`, where a `_count` or `_sum` of a histogram or summary is a counter.
 */
export function metricType(name: string, meta: MetricTypes): MetricKind {
  const own = kindOf(meta[name]?.[0]?.type);
  if (own !== null) return own;
  for (const suffix of SUFFIXES) {
    if (!name.endsWith(suffix)) continue;
    const base = kindOf(meta[name.slice(0, -suffix.length)]?.[0]?.type);
    if (base === null) return 'unknown';
    if ((suffix === '_count' || suffix === '_sum') && (base === 'histogram' || base === 'summary'))
      return 'counter';
    return base;
  }
  return 'unknown';
}

function isCounter(name: string, meta: MetricTypes): boolean {
  return metricType(name, meta) === 'counter' || name.endsWith('_total');
}

function isHistogram(name: string, meta: MetricTypes): boolean {
  const k = metricType(name, meta);
  return name.endsWith('_bucket') && (k === 'histogram' || k === 'unknown');
}

const DURATION_UNITS = [
  ['d', 86_400_000],
  ['h', 3_600_000],
  ['m', 60_000],
  ['s', 1_000],
] as const;

/** The largest of d, h, m, s that divides `ms` (`<ms>ms` when none does). */
export function formatDuration(ms: number): string {
  for (const [unit, size] of DURATION_UNITS) {
    if (ms > 0 && ms % size === 0) return `${String(ms / size)}${unit}`;
  }
  return `${String(ms)}ms`;
}

/** UTF-8 bytes of `s`; a lone surrogate counts 3 (as `TextEncoder`'s U+FFFD). */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        n += 4;
        i += 1;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

/**
 * The scrape interval the rate window assumes, in seconds. A per-binding value comes later; until
 * then every target is taken to be scraped every 15 s.
 */
export const DEFAULT_SCRAPE_S = 15;

/**
 * The rate window of a step: `max(4 × step, step + S, 4 × S)` with `S = DEFAULT_SCRAPE_S`, so a
 * window holds at least four scrapes however small the step (rate window floor from the reference
 * client behaviour; plan #63 §3.3 wrote `4 × step`).
 */
export function rateWindowMs(stepMs: number): number {
  const scrapeMs = DEFAULT_SCRAPE_S * 1000;
  return Math.max(4 * stepMs, stepMs + scrapeMs, 4 * scrapeMs);
}

function sized(p: Omit<RunPlan, 'bytes' | 'tooLong'>): RunPlan {
  const bytes = utf8Length(p.query);
  return { ...p, bytes, tooLong: bytes > MAX_QUERY_BYTES };
}

/** The request for `text`: the first matching row of plan #63 §3.3. */
export function planRun(
  text: string,
  shape: QueryShape,
  meta: MetricTypes,
  o: { readonly rate: boolean; readonly stepMs: number | null },
): RunPlan {
  const asIs = (rateCandidate: boolean, histogram: boolean, kind: RunPlan['kind']): RunPlan =>
    sized({
      kind,
      query: text,
      rateCandidate,
      rateApplied: false,
      histogram,
      sourceStart: 0,
      sourceEnd: text.length,
      sentStart: 0,
    });
  const bare = shape.bareSelector;
  if (bare !== null) {
    const stepMs = o.rate ? o.stepMs : null;
    const rewritten = (prefix: string, suffix: string, histogram: boolean): RunPlan =>
      sized({
        kind: 'range',
        query: `${prefix}${text.slice(bare.from, bare.to)}${suffix}`,
        rateCandidate: true,
        rateApplied: true,
        histogram,
        sourceStart: bare.from,
        sourceEnd: bare.to,
        sentStart: prefix.length,
      });
    if (isHistogram(bare.metric, meta)) {
      if (stepMs === null) return asIs(true, false, 'range');
      return rewritten('sum by (le) (rate(', `[${formatDuration(rateWindowMs(stepMs))}]))`, true);
    }
    if (isCounter(bare.metric, meta)) {
      if (stepMs === null) return asIs(true, false, 'range');
      return rewritten('rate(', `[${formatDuration(rateWindowMs(stepMs))}])`, false);
    }
  }
  const histogram = shape.metrics.some((m) => isHistogram(m, meta)) && !shape.hasHistogramQuantile;
  const instant = shape.valueType === 'scalar' || shape.valueType === 'string';
  return asIs(false, histogram, instant ? 'instant' : 'range');
}

/** The editor index of sent index `sentIndex`, or `null` outside the source slice (T09-009). */
export function toSourceIndex(plan: RunPlan, sentIndex: number): number | null {
  const len = plan.sourceEnd - plan.sourceStart;
  if (sentIndex < plan.sentStart || sentIndex > plan.sentStart + len) return null;
  return plan.sourceStart + (sentIndex - plan.sentStart);
}
