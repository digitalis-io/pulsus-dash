/**
 * The run of one board panel (plan #64 §3.2, §4.1–§4.3; ADR-0021): the panel sends its raw text,
 * the board variables it references, the board window and its body width (range) or its step
 * (instant), and reads every fact about the sent query from the server's `planned`. One TanStack
 * query under `['data', 'panel', …]` (the shell's refresh reaches it; a new key aborts the old
 * request, PRF-030), fresh within the window epoch only (`staleTime: Infinity`, `BoardRunProvider`).
 * A window or step change keeps the previous outcome as the placeholder; any other change does not.
 * A bar chart with a baseline offset (or its ghost on) sends the same query on the window moved
 * back by the offset beside the main one, in the same query function (plan #173 Part 3b §4.2).
 * A LogQL panel runs through `useLogPanelRun` (plan #67 §3.3); both hooks are called on every render
 * and the inactive one sends nothing and loads no language.
 */
import { useQuery } from '@tanstack/react-query';
import {
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
import { useApi } from '../app/providers';
import { isApiError, type DataPanelSpec } from '../api/types';
import { StoreBypass } from '../data/rangeStore';
import { promGrid } from '../data/step';
import type { Diagnostic } from '../editor/lang/types';
import type { TimeWindow } from '../engine/api';
import { refusalOf, runKind, type Refusal } from '../explore/useExploreRun';
import { useTimeContext } from '../state/useTimeContext';
import { fromInstant, fromRange, type ExploreResult } from '../vis/autovis';
import { baselineOffset, OFFSET_MS } from './baseline';
import { BoardRunContext } from './boardRunContext';
import { PENDING_KINDS } from './options';
import {
  panelIdleKey,
  panelRunKey,
  sameExceptWindow,
  sameKey,
  type PanelOutcome,
  type PanelState,
  type PanelStream,
} from './panelRun';
import { fromStore, outcomeOf, useStoreRun } from './panelStore';
import { chunkable } from './rangeView';
import { useLogPanelRun } from './useLogPanelRun';
import { useQueryLanguage } from './useQueryLanguage';
import { panelVars, referencedVariables } from './variableRefs';

export interface PanelRunInput {
  readonly tenant: string;
  readonly panel: DataPanelSpec;
  /** The text to run: the saved text, or the dialog's run text for the edited panel (§4.4). */
  readonly text: string;
  /** In the viewport, full screen open, or the preview. */
  readonly enabled: boolean;
  /** The board panel body's width (§3.4). */
  readonly widthPx: number | null;
  /** Runs of the same text (the editor's Run, plan #67 §3.3): a new LogQL pager each; default 0. */
  readonly runSeq?: number;
  /** The panel behind its open editor: a LogQL stream panel holds no pager (the preview has one). */
  readonly editing?: boolean;
  /**
   * The edited panel's Query field failed to load an import (#147): runs as `runKind`'s degraded
   * (without a language, the range route). Default false. The LogQL run ignores it.
   */
  readonly degraded?: boolean;
  /** The bar chart's baseline ghost is on (plan #173 Part 3b §4.2); default false. */
  readonly ghost?: boolean;
}

export type { PanelOutcome };

export interface PanelRun {
  /** The text this run is for (`diagnostics` index into it). */
  readonly text: string;
  readonly blocked: PanelState | null;
  /** The client hint, or the server's `variable.missing` names (§4.2). */
  readonly missing: readonly string[];
  /** `queryTooLarge` (the pre-check) or `tooLong` (the server's 413). */
  readonly refusal: Refusal | null;
  /** The language and width are known and nothing blocks the run. */
  readonly ready: boolean;
  /** The key's data, or the placeholder (§4.3). */
  readonly outcome: PanelOutcome | null;
  /** Null for none, for an `AbortError`, and for a missing variable or a 413. */
  readonly error: unknown;
  /** Indices into `text`; [] unless `queryInvalid`. */
  readonly diagnostics: readonly Diagnostic[];
  readonly fetching: boolean;
  readonly stepMs: number | null;
  /** `planned.expanded` of the current key's own response only (§3.5); else null. */
  readonly expanded: string | null;
  /** The LogQL stream path's pager and controls (plan #67); else null. */
  readonly stream: PanelStream | null;
  /** `outcome` is the previous key's result (TanStack `isPlaceholderData`; plan #234 Part 3 §2). */
  readonly placeholder: boolean;
  /** Runs the current key again (TanStack `refetch()`; the geomap's Retry). */
  readonly retry: () => void;
  /** `held`: the range store serves it; `bypass`: admission refused, the single request; `off`: not eligible (#304 §4.1). */
  readonly store: 'held' | 'bypass' | 'off';
  /** The outcome's rank (Part B): 0 a fill from other steps, 1 the view's own step; null: none. */
  readonly rank: 0 | 1 | null;
  /** Held spans not fresh for the view (#304 §4.3). */
  readonly stale: readonly TimeWindow[];
}

const NO_DIAGNOSTICS: readonly Diagnostic[] = Object.freeze([]);
const NO_NAMES: readonly string[] = Object.freeze([]);
const NO_RETRY = (): void => undefined;
export const NO_STALE: readonly TimeWindow[] = Object.freeze([]);

export function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}

/** The `variable.missing` names of a 400, in field order; null for any other error. */
export function missingOf(e: unknown): string[] | null {
  if (!isApiError(e, 'invalid') || e.fields.length === 0) return null;
  if (!e.fields.every((f) => f.messageKey === 'variable.missing')) return null;
  return e.fields.map((f) => f.pointer.replace(/^\/vars\//, ''));
}

/** The panel's run: its language's hook (plan #67 §3.3). */
export function usePanelRun(a: PanelRunInput): PanelRun {
  const logql = a.panel.query.lang === 'logql';
  const prom = usePromPanelRun(a, !logql);
  const logs = useLogPanelRun(a, logql);
  return logql ? logs : prom;
}

/** A PromQL panel's run; inactive (a LogQL panel), an idle key and no language. */
function usePromPanelRun(a: PanelRunInput, active: boolean): PanelRun {
  const api = useApi();
  const { vars, timeReady } = useContext(BoardRunContext);
  const { window, anchorMs, refreshEpoch } = useTimeContext();
  const { tenant, panel, text, enabled, widthPx } = a;
  const { fromMs, toMs } = window;
  const { lang, failed } = useQueryLanguage(active ? 'promql' : null);
  const degraded = a.degraded ?? false;

  const hint = useMemo(() => referencedVariables(text).filter((n) => !vars.has(n)), [text, vars]);
  const refusedEarly = useMemo(() => refusalOf(text), [text]);
  const pre: PanelState | null = !active
    ? null
    : PENDING_KINDS.has(panel.vis.kind)
      ? 'kindUnavailable'
      : panel.vis.kind === 'logs'
        ? 'logs'
        : text.trim() === ''
          ? 'empty'
          : refusedEarly !== null
            ? 'refused'
            : hint.length > 0
              ? 'variable'
              : failed && !degraded
                ? 'langFailed'
                : null;

  // Nothing is planned before the board's time is set (§4.6).
  const stepMs =
    timeReady && widthPx !== null && widthPx > 0
      ? (promGrid(fromMs, toMs, widthPx)?.stepMs ?? null)
      : null;
  const kind = useMemo(
    () => (active && timeReady && pre === null ? runKind(text, lang, degraded) : null),
    [active, timeReady, pre, text, lang, degraded],
  );
  const sentPairs = useMemo(() => panelVars(text, vars), [text, vars]);
  const varsJson = useMemo(() => JSON.stringify(sentPairs), [sentPairs]);
  // The bar chart's baseline run (plan #173 Part 3b §4.2): its offset, or null for none.
  const ghost = a.ghost ?? false;
  const off = panel.vis.kind === 'barchart' ? baselineOffset(panel.vis.options, ghost) : null;
  const baselineMs = off === null ? null : OFFSET_MS[off];
  const runKey = useMemo(
    () =>
      kind !== null && stepMs !== null
        ? panelRunKey(
            tenant,
            panel.id,
            { text, vars: varsJson },
            kind,
            stepMs,
            { fromMs, toMs },
            baselineMs,
          )
        : null,
    [kind, stepMs, tenant, panel.id, text, varsJson, fromMs, toMs, baselineMs],
  );
  const key = useMemo(
    () => runKey ?? panelIdleKey(tenant, panel.id, text),
    [runKey, tenant, panel.id, text],
  );

  // Store-backed (#304 §4.1): a line panel's PromQL range run, chunkable, no baseline, not
  // degraded. Other kinds keep today's single request (through the scheduler).
  const eligible =
    panel.vis.kind === 'line' &&
    runKey !== null &&
    kind === 'range' &&
    baselineMs === null &&
    !degraded &&
    chunkable(text) &&
    widthPx !== null &&
    widthPx > 0;
  const sr = useStoreRun(
    eligible
      ? {
          tenant,
          text,
          vars: varsJson,
          rate: true,
          line: panel.vis.kind === 'line',
          window: { fromMs, toMs },
          widthPx,
          epoch: refreshEpoch,
          anchorMs,
        }
      : null,
    enabled && runKey !== null,
    key,
  );
  const view = sr.backed ? sr.view : null;
  const { store } = sr;
  // Part B §4.3: the placeholder while the view's own run loads: a fill from the family's other
  // steps (rank 0), or the view's own data once held (rank 1), so the panel never drops back to
  // loading between the fill and the answer.
  const filled = useSyncExternalStore(
    (cb) => store.subscribe(view?.idKey ?? '', cb),
    () => (view === null ? null : store.peekFilled(view)),
  );

  // Read by the query function: a width change within one step does not refetch.
  const widthRef = useRef(widthPx);
  // What was shown last (Part B: a rank 1 answer over a rank 0 fill of the same key crossfades).
  const shownRef = useRef<{ readonly key: readonly unknown[]; readonly rank: 0 | 1 } | null>(null);
  useLayoutEffect(() => {
    widthRef.current = widthPx;
  });

  const query = useQuery({
    queryKey: key,
    enabled: enabled && runKey !== null,
    // Fresh within the window epoch only: the provider invalidates (§4.1).
    staleTime: Infinity,
    ...(view === null ? {} : { gcTime: 0 }),
    retry: false,
    structuralSharing: false,
    // A pan within held data is painted in its first render, with no request (PRF-028).
    initialData:
      view === null
        ? undefined
        : () => {
            const held = store.peek(view);
            return held !== null && held.stale.length === 0
              ? outcomeOf(key, held, view.id.scope)
              : undefined;
          },
    placeholderData: (prev: PanelOutcome | undefined, prevQuery) => {
      if (view !== null && filled !== null) return outcomeOf(key, filled, view.id.scope);
      if (
        prevQuery === undefined ||
        prevQuery.state.status === 'error' ||
        !sameExceptWindow(prevQuery.queryKey, key)
      ) {
        return undefined;
      }
      // Store-derived data is reused only under its scope and a valid lease (§4.5).
      if (fromStore(prev) && (!sr.lease || prev?.scope !== sr.scope)) return undefined;
      return prev;
    },
    queryFn: async ({ signal, queryKey }): Promise<PanelOutcome> => {
      if (kind === null || stepMs === null) throw new Error('panel: a run without its inputs');
      if (view !== null) {
        try {
          // Part B §4.3: a run that starts over a rank 0 fill of this key crossfades into it.
          const overFill = store.peek(view) === null && store.peekFilled(view)?.rank === 0;
          const shown = shownRef.current;
          const overShown = shown?.rank === 0 && sameKey(shown.key, queryKey);
          const held = await store.load(sr.owner, view, signal);
          const fade =
            held.rank === 1 && (overFill || overShown) ? ('crossfade' as const) : undefined;
          return outcomeOf(queryKey, held, view.id.scope, fade);
        } catch (e) {
          // Admission refused (§4.2): today's single request below.
          if (!(e instanceof StoreBypass)) throw e;
        }
      }
      const sent = Object.fromEntries(sentPairs);
      const widthPx = widthRef.current ?? 0;
      // One request: the panel's window, or that window moved back by `shift` (the baseline).
      // Every board range request runs through the page's one scheduler (§4.6).
      const request = async (shift: number, s: AbortSignal): Promise<PanelOutcome> => {
        if (kind === 'range') {
          const r = await store.scheduler.exec(s, (sig, priority) =>
            api.queryRange(
              tenant,
              {
                query: text,
                fromMs: fromMs - shift,
                toMs: toMs - shift,
                widthPx,
                vars: sent,
                rate: true,
                priority,
              },
              sig,
            ),
          );
          if (r.scope !== undefined && r.scope !== null) {
            store.observeScope(tenant, r.scope, store.now());
          }
          return { key: queryKey, planned: r.planned, result: fromRange(r) };
        }
        const r = await api.queryInstant(
          tenant,
          { query: text, atMs: toMs - shift, vars: sent, stepMs },
          s,
        );
        return { key: queryKey, planned: r.planned, result: fromInstant(r) };
      };
      if (baselineMs === null) return request(0, signal);
      // One run controller linked to the query's signal (§4.2): the query's abort (a new key, an
      // unmount) aborts both requests; a failed main request aborts the baseline. A failed
      // baseline never fails the panel.
      const run = new AbortController();
      const onAbort = (): void => {
        run.abort(signal.reason);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        const main = request(0, run.signal).catch((e: unknown) => {
          run.abort();
          throw e;
        });
        const base: Promise<ExploreResult | 'failed'> = request(baselineMs, run.signal).then(
          (o) => o.result,
          () => 'failed' as const,
        );
        // Rejects with the main request's error first; the baseline promise never rejects.
        const [m, b] = await Promise.all([main, base]);
        return { ...m, baseline: run.signal.aborted ? 'failed' : b };
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    },
  });

  // Past the lease a mounted panel's store data is not painted: it revalidates first (§4.5).
  const data = runKey === null ? null : (query.data ?? null);
  const leased = data !== null && fromStore(data) && (!sr.lease || data.scope !== sr.scope);
  const { refetch } = query;
  const isFetching = query.isFetching;
  useEffect(() => {
    if (leased && enabled && !isFetching) void refetch();
  }, [leased, enabled, isFetching, refetch]);
  // A same-key view that the held data no longer satisfies (Refresh now under an absolute
  // window: a new refresh epoch; the shell's refetch ran before this render's view): load again.
  const behind = view !== null && data !== null && fromStore(data) && !store.fresh(view);
  useEffect(() => {
    if (behind && enabled && !isFetching) void refetch({ cancelRefetch: true });
  }, [behind, view, enabled, isFetching, refetch]);

  const rejection = query.isError && !isAbort(query.error) ? query.error : null;
  const serverMissing = useMemo(() => missingOf(rejection), [rejection]);
  const serverRefused = isApiError(rejection, 'queryTooLong');
  const blocked: PanelState | null =
    pre ?? (serverMissing !== null ? 'variable' : serverRefused ? 'refused' : null);
  const missing = pre === 'variable' ? hint : (serverMissing ?? NO_NAMES);
  const refusal: Refusal | null =
    pre === 'refused' ? refusedEarly : pre === null && serverRefused ? 'tooLong' : null;
  const error = blocked === null ? rejection : null;

  const diagnostics = useMemo(
    () =>
      isApiError(error, 'queryInvalid') && lang !== null
        ? // The server maps the position into the raw text (ADR-0021 §3): the identity.
          lang.diagnosticsOf(text, error, (i) => i, text)
        : NO_DIAGNOSTICS,
    [error, text, lang],
  );

  const outcome = leased ? null : data;
  useEffect(() => {
    shownRef.current = outcome === null ? null : { key: outcome.key, rank: outcome.rank ?? 1 };
  }, [outcome]);
  const expanded =
    runKey === null
      ? null
      : query.isError
        ? isApiError(rejection)
          ? (rejection.detail.planned?.expanded ?? null)
          : null
        : outcome !== null && !query.isPlaceholderData && sameKey(outcome.key, runKey)
          ? outcome.planned.expanded
          : null;

  const fetching = query.isFetching;
  const storeState: PanelRun['store'] = sr.view === null ? 'off' : sr.backed ? 'held' : 'bypass';
  const rank = outcome?.rank ?? null;
  const stale = sr.backed ? sr.stale : NO_STALE;
  return useMemo(
    () => ({
      text,
      blocked,
      missing,
      refusal,
      ready: runKey !== null && blocked === null,
      outcome,
      error,
      diagnostics,
      fetching,
      stepMs,
      expanded,
      stream: null,
      placeholder: false,
      retry: NO_RETRY,
      store: storeState,
      rank,
      stale,
    }),
    [
      text,
      blocked,
      missing,
      refusal,
      runKey,
      outcome,
      error,
      diagnostics,
      fetching,
      stepMs,
      expanded,
      storeState,
      rank,
      stale,
    ],
  );
}
