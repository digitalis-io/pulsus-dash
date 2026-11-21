/**
 * The Explore run (plan #63 Part C §3.1, §4.1, §4.4; SRF-027, SRF-030, PRF-030, IA-020): the URL
 * query planned with the definitive inputs, sent as one TanStack query under the `['data']` prefix
 * (a newer key aborts the older request; the shell's refresh cancels and reruns it), and the last
 * success kept in hook state (D-RUN), so an error or a pending key never blanks the chart.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useApi } from '../app/providers';
import type { QueryLanguage } from '../editor/lang/types';
import { fromInstant, fromRange, type ExploreResult } from '../vis/autovis';
import type { FramePlan } from '../vis/framePlan';
import { planRun, type MetricTypes, type RunPlan } from './plan';
import { overQueryLimit } from './querySize';

/** The frame plan of a string result, whatever the vis. */
export const STRING_PLAN: FramePlan = { spec: null, data: null, notice: 'string' };

export type Refusal = 'queryTooLarge' | 'tooLong';

export interface RunOutcome {
  /** The URL query that ran (the editor text it maps back to). */
  readonly text: string;
  readonly plan: RunPlan;
  readonly result: ExploreResult;
  readonly durationMs: number;
}

export interface ExploreRun {
  /** `planFor(q, …)`: null when `q` is empty or an input is pending. */
  readonly plan: RunPlan | null;
  /** `refusalOf(q, plan)`: no request is made. */
  readonly refusal: Refusal | null;
  /** The outcome shown (D-RUN); always null when `q` is empty. */
  readonly shown: RunOutcome | null;
  /** The current key's error; null when none, or an `AbortError`. */
  readonly error: unknown;
  readonly fetching: boolean;
  /** Aborts the key's request in flight, its first fetch included, then fetches again. */
  rerun(): void;
}

export interface PlanInputs {
  readonly lang: QueryLanguage | null;
  /** Null while the metadata query is pending; `{}` after its error. */
  readonly meta: MetricTypes | null;
  /** `promGrid(fromMs, toMs, widthPx).stepMs`; null while the width is unknown. */
  readonly stepMs: number | null;
  readonly rate: boolean;
}

export interface RunInput {
  readonly tenant: string;
  readonly q: string;
  readonly inputs: PlanInputs;
  /** Read through a ref by the query function: a width change within one step does not refetch. */
  readonly widthPx: number | null;
  readonly window: { readonly fromMs: number; readonly toMs: number };
}

/** True when the language, the metadata and the step are known: the inputs of the definitive plan. */
export function plannable(i: PlanInputs): boolean {
  return i.lang !== null && i.meta !== null && i.stepMs !== null;
}

/**
 * The one planner call of the page: the hook and the Run handler both use it, so the text checked
 * at Run is the text the hook sends. Null for blank text or while an input is pending.
 */
export function planFor(text: string, i: PlanInputs): RunPlan | null {
  if (text.trim() === '' || i.lang === null || i.meta === null || i.stepMs === null) return null;
  return planRun(text, i.lang.shape(text), i.meta, { rate: i.rate, stepMs: i.stepMs });
}

/** Above 128 KB of UTF-8 (T09-015), or a sent text over the BFF's 64 KiB (B.8 #12). */
export function refusalOf(text: string, plan: RunPlan | null): Refusal | null {
  if (overQueryLimit(text)) return 'queryTooLarge';
  if (plan?.tooLong === true) return 'tooLong';
  return null;
}

/** `['data', 'explore', tenant, q, sent, kind, histogram, fromMs, toMs, step]`. */
export function exploreRunKey(
  tenant: string,
  q: string,
  plan: RunPlan,
  w: { readonly fromMs: number; readonly toMs: number },
  stepMs: number | null,
): readonly unknown[] {
  return [
    'data',
    'explore',
    tenant,
    q,
    plan.query,
    plan.kind,
    plan.histogram,
    w.fromMs,
    w.toMs,
    plan.kind === 'range' ? stepMs : null,
  ];
}

function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}

interface Last {
  readonly tenant: string;
  readonly outcome: RunOutcome;
}

export function useExploreRun(a: RunInput): ExploreRun {
  const api = useApi();
  const queryClient = useQueryClient();
  const { tenant, q, inputs } = a;
  const { fromMs, toMs } = a.window;
  const plan = useMemo(() => planFor(q, inputs), [q, inputs]);
  const refusal = useMemo(() => refusalOf(q, plan), [q, plan]);
  const widthRef = useRef(a.widthPx);
  useLayoutEffect(() => {
    widthRef.current = a.widthPx;
  });

  const key = useMemo(
    () =>
      plan === null
        ? ['data', 'explore', tenant, q, null]
        : exploreRunKey(tenant, q, plan, { fromMs, toMs }, inputs.stepMs),
    [tenant, q, plan, fromMs, toMs, inputs.stepMs],
  );

  const query = useQuery({
    queryKey: key,
    enabled: plan !== null && refusal === null,
    retry: false,
    structuralSharing: false,
    placeholderData: (prev: RunOutcome | undefined, prevQuery) =>
      prevQuery?.queryKey[2] === tenant ? prev : undefined,
    queryFn: async ({ signal }): Promise<RunOutcome> => {
      if (plan === null) throw new Error('explore: a run without a plan');
      const t0 = performance.now();
      const result =
        plan.kind === 'range'
          ? fromRange(
              await api.queryRange(
                tenant,
                { query: plan.query, fromMs, toMs, widthPx: widthRef.current ?? 0 },
                signal,
              ),
            )
          : fromInstant(await api.queryInstant(tenant, { query: plan.query, atMs: toMs }, signal));
      return { text: q, plan, result, durationMs: Math.round(performance.now() - t0) };
    },
  });

  const refetch = query.refetch;
  const rerun = useCallback(() => {
    void queryClient.cancelQueries({ queryKey: key, exact: true }).then(() => refetch());
  }, [queryClient, key, refetch]);

  const [last, setLast] = useState<Last | null>(null);
  const data = query.data;
  // Kept while rendering (not in an effect): the last success of this key that is not a placeholder.
  if (
    data !== undefined &&
    !query.isPlaceholderData &&
    (last?.tenant !== tenant || last.outcome !== data)
  ) {
    setLast({ tenant, outcome: data });
  }

  const kept = last?.tenant === tenant ? last.outcome : null;
  const shown = q === '' ? null : query.isError ? kept : (data ?? kept);
  const error = query.isError && !isAbort(query.error) ? query.error : null;

  return useMemo(
    () => ({ plan, refusal, shown, error, fetching: query.isFetching, rerun }),
    [plan, refusal, shown, error, query.isFetching, rerun],
  );
}
