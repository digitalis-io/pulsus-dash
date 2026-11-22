/**
 * The types shared by the query editor (Part B of #63) and the Explore route (plan #63 §3.2), and
 * the `QueryLanguage` interface of T09 §5.1 (ADR-0018). This module has no run-time imports, so the
 * route chunk can import it without the editor chunk.
 */
import type { Extension } from '@codemirror/state';
import type { QueryClient } from '@tanstack/react-query';
import type { Api } from '../../api/Api';
import type { SuggestCache } from '../suggestCache';

/** The PromQL value type of a whole query; `unknown` when it does not parse. */
export type ValueType = 'scalar' | 'string' | 'vector' | 'matrix' | 'unknown';

/** A query's shape from the Lezer tree: the run route (`runKind`) and the StubApi mirror read it. */
export interface QueryShape {
  /** Top-level VectorSelector with a metric-name Identifier, and its exact source slice. */
  readonly bareSelector: {
    readonly metric: string;
    readonly from: number;
    readonly to: number;
  } | null;
  /** Identifier of every VectorSelector, in order of appearance, without duplicates. */
  readonly metrics: readonly string[];
  readonly hasHistogramQuantile: boolean;
  readonly valueType: ValueType;
}

/** The shape of a query the analyser cannot read: nothing is rewritten or hinted. */
export const UNKNOWN_SHAPE: QueryShape = Object.freeze({
  bareSelector: null,
  metrics: [],
  hasHistogramQuantile: false,
  valueType: 'unknown',
});

export interface Diagnostic {
  /** UTF-16 index into the editor text. */
  readonly from: number;
  /** UTF-16 index into the editor text. */
  readonly to: number;
  readonly message: string;
  /** False when the data source gave no position: the whole text is marked. */
  readonly positionKnown: boolean;
}

/** The query languages of T09 §5.1. Each has a directory `lang/<id>/` (ADR-0018). */
export type LangId = 'promql' | 'logql' | 'traceql' | 'profile';

/**
 * What a language's editor extensions need for upstream lookups (T09 §5.1, ADR-0018): the BFF
 * client, the tenant (the key of the suggest cache, T09-014; no `scope_fp` while data scopes are
 * deferred, D12) and the window shown now.
 */
export interface LanguageDeps {
  readonly api: Api;
  readonly queryClient: QueryClient;
  readonly tenant: string;
  /** The window shown now, read on each lookup. */
  readonly window: () => { readonly fromMs: number; readonly toMs: number };
  /** Default the module's `suggestCache` (tests inject their own). */
  readonly cache?: SuggestCache;
}

/** One query language (T09 §5.1, T09-001). Reached only through this interface and `LANGUAGES`. */
export interface QueryLanguage {
  readonly lang: LangId;
  /**
   * Highlighting (T09-003) and completion over this language's lookups (T09-007, T09-014). The
   * completion source is the `autocomplete` language data; the host's completion guard runs it.
   */
  editor(deps: LanguageDeps): readonly Extension[];
  shape(text: string): QueryShape;
  /** The diagnostics of a failed run; `toSource` maps an index of `sent` to the editor text. */
  diagnosticsOf(
    text: string,
    error: unknown,
    toSource: (sentIndex: number) => number | null,
    sent: string,
  ): Diagnostic[];
  /** How strongly `prefix` looks like this language (⌘K detection, INT-038); 0 is no claim. */
  detect(prefix: string): number;
}

/** Completion data (never rejects: a failure resolves empty). */
export interface PromSource {
  metricNames(): Promise<readonly string[]>;
  labelNames(match: string | null): Promise<readonly string[]>;
  labelValues(name: string, match: string | null): Promise<readonly string[]>;
  series(match: string): Promise<readonly Readonly<Record<string, string>>[]>;
  metadata(): Promise<
    Readonly<Record<string, readonly { readonly type: string; readonly help: string }[]>>
  >;
}
