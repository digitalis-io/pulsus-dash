/**
 * The types shared by the query editor (Part B of #63) and the Explore route (plan #63 §3.2). This
 * module has no run-time imports, so the route chunk can import it without the editor chunk.
 */

/** The PromQL value type of a whole query; `unknown` when it does not parse. */
export type ValueType = 'scalar' | 'string' | 'vector' | 'matrix' | 'unknown';

/** What the planner needs to know about a query's text (`explore/plan.ts`). */
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

export interface QueryLanguage {
  readonly lang: 'promql';
  shape(text: string): QueryShape;
  /** The diagnostics of a failed run; `toSource` maps an index of `sent` to the editor text. */
  diagnosticsOf(
    text: string,
    error: unknown,
    toSource: (sentIndex: number) => number | null,
    sent: string,
  ): Diagnostic[];
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
