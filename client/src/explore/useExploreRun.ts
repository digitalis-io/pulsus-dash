/**
 * The Explore run (plan #63 Part C §3.1, §4.1, §4.4; plan #112 §3.10; SRF-027, SRF-030, PRF-030,
 * IA-020): the URL query sent as is with the run's inputs (the rate chip, the width, the step) as
 * one TanStack query under the `['data']` prefix (a newer key aborts the older request; the shell's
 * refresh cancels and reruns it). The server plans it (ADR-0021): every fact the page shows about
 * the sent query is read from the result's `planned`. The last success is kept in hook state
 * (D-RUN), so an error or a pending key never blanks the chart.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useApi } from '../app/providers';
import { useRangeStore } from '../data/useRangeStore';
import { chunkable, planRangeView } from '../boards/rangeView';
import { StoreBypass, type Assembled } from '../data/rangeStore';
import type { PlannedQuery } from '../data/decode';
import type { QueryLanguage } from '../editor/lang/types';
import { fromInstant, fromRange, type ExploreResult } from '../vis/autovis';
import type { FramePlan } from '../vis/framePlan';
import { overQueryLimit } from './querySize';

/** The frame plan of a string result, whatever the vis. */
export const STRING_PLAN: FramePlan = { spec: null, data: null, notice: 'string' };

/** A refused Run: over 128 KB (the page's pre-check), or the server's 413 on the planned text. */
export type Refusal = 'queryTooLarge' | 'tooLong';

export interface RunOutcome {
  /** The URL query that ran (the editor text the server's positions refer to). */
  readonly text: string;
  /** What the server planned and sent. */
  readonly planned: PlannedQuery;
  readonly result: ExploreResult;
  /** Through the range store (#304 Part B §2): the scope epoch it was assembled under. */
  readonly scope?: string;
  readonly durationMs: number;
}

export interface ExploreRun {
  /** `runKind(q, lang, degraded)`: null when `q` is blank, or no language and not degraded. */
  readonly kind: 'range' | 'instant' | null;
  /** `refusalOf(q)`: no request is made. */
  readonly refusal: 'queryTooLarge' | null;
  /** The outcome shown (D-RUN); always null when `q` is empty. */
  readonly shown: RunOutcome | null;
  /** The current key's error; null when none, or an `AbortError`. */
  readonly error: unknown;
  readonly fetching: boolean;
  /** Aborts the key's request in flight, its first fetch included, then fetches again. */
  rerun(): void;
}

export interface RunInputs {
  readonly lang: QueryLanguage | null;
  /** The field's imports failed: run without a language when it is not loaded (#147). */
  readonly degraded: boolean;
  /** `promGrid(fromMs, toMs, widthPx).stepMs`; null while the width is unknown. */
  readonly stepMs: number | null;
  readonly rate: boolean;
}

export interface RunInput {
  readonly tenant: string;
  readonly q: string;
  readonly inputs: RunInputs;
  /** Read through a ref by the query function: a width change within one step does not refetch. */
  readonly widthPx: number | null;
  readonly window: { readonly fromMs: number; readonly toMs: number };
  /** The clock anchor and the refresh epoch of the window (the range store's freshness, #304). */
  readonly anchorMs?: number;
  readonly epoch?: number;
}

/** True when the language (or `degraded`) and the step are known: the inputs of a run. */
export function runnable(i: RunInputs): boolean {
  return (i.lang !== null || i.degraded) && i.stepMs !== null;
}

/**
 * The route of `text`: an instant query when its type is scalar or string (Lezer's shape: the
 * server plans the text either way); null when blank, or without a language unless `degraded`
 * (#147): then every query is a range query. A loaded language always wins.
 */
export function runKind(
  text: string,
  lang: QueryLanguage | null,
  degraded = false,
): 'range' | 'instant' | null {
  if (text.trim() === '') return null;
  if (lang === null) return degraded ? 'range' : null;
  const vt = lang.shape(text).valueType;
  return vt === 'scalar' || vt === 'string' ? 'instant' : 'range';
}

/** Above 128 KB of UTF-8 (T09-015): nothing is sent. The server checks every other limit. */
export function refusalOf(text: string): 'queryTooLarge' | null {
  return overQueryLimit(text) ? 'queryTooLarge' : null;
}

/** `['data', 'explore', tenant, q, kind, rate, fromMs, toMs, step]`. */
export function exploreRunKey(
  tenant: string,
  q: string,
  kind: 'range' | 'instant',
  rate: boolean,
  w: { readonly fromMs: number; readonly toMs: number },
  stepMs: number,
): readonly unknown[] {
  return ['data', 'explore', tenant, q, kind, rate, w.fromMs, w.toMs, stepMs];
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
  const { lang, degraded, stepMs, rate } = inputs;
  const kind = useMemo(() => runKind(q, lang, degraded), [q, lang, degraded]);
  const refusal = useMemo(() => refusalOf(q), [q]);
  const widthRef = useRef(a.widthPx);
  useLayoutEffect(() => {
    widthRef.current = a.widthPx;
  });

  const key = useMemo(
    () =>
      kind === null || stepMs === null
        ? ['data', 'explore', tenant, q, null]
        : exploreRunKey(tenant, q, kind, rate, { fromMs, toMs }, stepMs),
    [tenant, q, kind, rate, fromMs, toMs, stepMs],
  );

  // The range run through the page's range store (#304 Part B §2), with Part A's eligibility;
  // the chart draws the visible slice, a one-window pan paints from held flanks.
  const store = useRangeStore();
  const owner = `explore:${useId()}`;
  const scope = useSyncExternalStore(
    (cb) => store.subscribe(tenant, cb),
    () => store.scopeOf(tenant),
  );
  const lease = useSyncExternalStore(
    (cb) => store.subscribe(tenant, cb),
    () => store.leaseValid(tenant),
  );
  const widthPx = a.widthPx;
  const anchorMs = a.anchorMs ?? toMs;
  // Run (rerun) asks again even when the store holds the window: a local epoch on top of the page's.
  const [runSeq, setRunSeq] = useState(0);
  const epoch = (a.epoch ?? 0) + runSeq;
  const planned = useMemo(
    () =>
      store.enabled &&
      kind === 'range' &&
      stepMs !== null &&
      chunkable(q) &&
      widthPx !== null &&
      widthPx > 0
        ? planRangeView({
            tenant,
            scope,
            text: q,
            vars: '[]',
            rate,
            line: true,
            window: { fromMs, toMs },
            widthPx,
            epoch,
            anchorMs,
          })
        : null,
    [store, kind, stepMs, q, widthPx, tenant, scope, rate, fromMs, toMs, epoch, anchorMs],
  );
  const bypassed = useSyncExternalStore(
    (cb) => store.subscribe(planned?.idKey ?? '', cb),
    () => planned !== null && store.bypassed(planned.idKey),
  );
  const view = bypassed ? null : planned;
  const enabled = kind !== null && runnable(inputs) && refusal === null;
  useEffect(() => {
    if (!enabled || view === null) return;
    store.retain(owner, view);
    return () => {
      store.release(owner);
    };
  }, [store, owner, view, enabled]);
  const fromAssembly = (a: Assembled, durationMs: number): RunOutcome => ({
    text: q,
    planned: a.visible.planned,
    result: fromRange(a.visible),
    durationMs,
    scope: view?.id.scope ?? '',
  });

  const query = useQuery({
    queryKey: key,
    enabled,
    retry: false,
    structuralSharing: false,
    initialData:
      view === null
        ? undefined
        : () => {
            const held = store.peek(view);
            return held !== null && held.stale.length === 0 ? fromAssembly(held, 0) : undefined;
          },
    placeholderData: (prev: RunOutcome | undefined, prevQuery) =>
      prevQuery?.queryKey[2] === tenant &&
      (prev?.scope === undefined || (lease && prev.scope === scope))
        ? prev
        : undefined,
    queryFn: async ({ signal }): Promise<RunOutcome> => {
      if (kind === null || stepMs === null) throw new Error('explore: a run without its inputs');
      const t0 = performance.now();
      const done = (planned: PlannedQuery, result: ExploreResult): RunOutcome => ({
        text: q,
        planned,
        result,
        durationMs: Math.round(performance.now() - t0),
      });
      if (kind === 'range') {
        if (view !== null) {
          try {
            const held = await store.load(owner, view, signal);
            return fromAssembly(held, Math.round(performance.now() - t0));
          } catch (e) {
            if (!(e instanceof StoreBypass)) throw e;
          }
        }
        const r = await store.scheduler.exec(signal, (sig, priority) =>
          api.queryRange(
            tenant,
            { query: q, fromMs, toMs, widthPx: widthRef.current ?? 0, rate, priority },
            sig,
          ),
        );
        if (r.scope !== undefined && r.scope !== null) {
          store.observeScope(tenant, r.scope, store.now());
        }
        return done(r.planned, fromRange(r));
      }
      const r = await api.queryInstant(tenant, { query: q, atMs: toMs, stepMs }, signal);
      return done(r.planned, fromInstant(r));
    },
  });

  const refetch = query.refetch;
  const rerun = useCallback(() => {
    setRunSeq((n) => n + 1);
    void queryClient.cancelQueries({ queryKey: key, exact: true }).then(() => refetch());
  }, [queryClient, key, refetch]);
  // A same-key view the held data no longer satisfies (Run, Refresh now): load again.
  const behind =
    view !== null &&
    query.data !== undefined &&
    query.data.scope !== undefined &&
    !store.fresh(view);
  const fetchingNow = query.isFetching;
  useEffect(() => {
    if (behind && !fetchingNow) void refetch({ cancelRefetch: true });
  }, [behind, view, fetchingNow, refetch]);

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
  const candidate = q === '' ? null : query.isError ? kept : (data ?? kept);
  // Store-derived data past the lease, or of another scope, is not shown before revalidation.
  const leased = candidate?.scope !== undefined && (!lease || candidate.scope !== scope);
  const shown = leased ? null : candidate;
  const isFetching = query.isFetching;
  useEffect(() => {
    if (leased && enabled && !isFetching) void refetch();
  }, [leased, enabled, isFetching, refetch]);
  const error = query.isError && !isAbort(query.error) ? query.error : null;

  return useMemo(
    () => ({ kind, refusal, shown, error, fetching: query.isFetching, rerun }),
    [kind, refusal, shown, error, query.isFetching, rerun],
  );
}
